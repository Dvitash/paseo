export interface ForegroundTimelineRecoveryPorts {
  verifyConnection: () => Promise<boolean>;
  synchronize: () => void;
  setActive: (active: boolean) => void;
  schedule: (task: () => void, delayMs: number) => () => void;
  reportError: (error: unknown) => void;
}

const VERIFICATION_DEADLINE_MS = 5_000;
const MAX_RETRY_DELAY_MS = 15_000;

/** Bounds the caller's wait too: a verification promise created before browser
 * suspension must not own this foreground generation indefinitely. */
export function createForegroundTimelineRecovery(ports: ForegroundTimelineRecoveryPorts) {
  let generation = 0;
  let active = false;
  let disposed = false;
  let retryDelayMs = 1_000;
  let cancelDeadline: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;

  const cancelScheduled = () => {
    cancelDeadline?.();
    cancelDeadline = null;
    cancelRetry?.();
    cancelRetry = null;
  };

  const owns = (request: number) => !disposed && active && generation === request;

  const attempt = (request: number): void => {
    if (!owns(request)) return;
    let settled = false;
    const finish = (verified: boolean, error?: unknown) => {
      if (settled || !owns(request)) return;
      settled = true;
      cancelDeadline?.();
      cancelDeadline = null;
      if (verified) {
        try {
          ports.synchronize();
          retryDelayMs = 1_000;
          return;
        } catch (synchronizationError) {
          error = synchronizationError;
        }
      }
      ports.reportError(error ?? new Error("Foreground connection verification failed"));
      cancelRetry = ports.schedule(() => {
        cancelRetry = null;
        attempt(request);
      }, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    };

    cancelDeadline = ports.schedule(
      () => finish(false, new Error("Foreground connection verification timed out")),
      VERIFICATION_DEADLINE_MS,
    );
    void Promise.resolve()
      .then(() => (owns(request) ? ports.verifyConnection() : false))
      .then((verified) => finish(verified))
      .catch((error) => finish(false, error));
  };

  return {
    resume(): void {
      if (disposed) return;
      active = true;
      generation += 1;
      cancelScheduled();
      retryDelayMs = 1_000;
      attempt(generation);
    },
    suspend(): void {
      if (disposed) return;
      active = false;
      generation += 1;
      cancelScheduled();
      ports.setActive(false);
    },
    dispose(): void {
      disposed = true;
      generation += 1;
      cancelScheduled();
    },
  };
}
