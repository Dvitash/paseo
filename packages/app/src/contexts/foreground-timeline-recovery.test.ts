import { expect, test } from "vitest";
import { createForegroundTimelineRecovery } from "./foreground-timeline-recovery";

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle() {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

function setup() {
  const requests: ReturnType<typeof deferred>[] = [];
  const calls: string[] = [];
  const errors: unknown[] = [];
  const tasks = new Map<number, { task: () => void; delay: number }>();
  let taskId = 0;
  const recovery = createForegroundTimelineRecovery({
    verifyConnection: () => {
      const request = deferred();
      requests.push(request);
      calls.push("verify");
      return request.promise;
    },
    synchronize: () => {
      calls.push("synchronize");
    },
    setActive: (active) => {
      calls.push(`active:${active}`);
    },
    schedule: (task, delay) => {
      const id = ++taskId;
      tasks.set(id, { task, delay });
      return () => {
        tasks.delete(id);
      };
    },
    reportError: (error) => {
      errors.push(error);
    },
  });
  return {
    recovery,
    requests,
    calls,
    errors,
    tasks,
    run(delay: number) {
      const entry = [...tasks].find(([, scheduled]) => scheduled.delay === delay);
      if (!entry) throw new Error(`No task at ${delay}ms`);
      tasks.delete(entry[0]);
      entry[1].task();
    },
  };
}

test("every resume synchronizes after verification, without needing a visibility boolean change", async () => {
  const app = setup();
  app.recovery.resume();
  await settle();
  expect(app.calls).toEqual(["verify"]);
  app.requests[0]!.resolve(true);
  await settle();
  app.recovery.resume();
  await settle();
  app.requests[1]!.resolve(true);
  await settle();
  expect(app.calls).toEqual(["verify", "synchronize", "verify", "synchronize"]);
  expect(app.tasks.size).toBe(0);
  app.recovery.dispose();
});

test("a newer resume proceeds without waiting for a pre-suspension verification", async () => {
  const app = setup();
  app.recovery.resume();
  await settle();
  app.recovery.suspend();
  app.recovery.resume();
  await settle();
  app.requests[1]!.resolve(true);
  await settle();
  app.requests[0]!.resolve(true);
  await settle();
  expect(app.calls).toEqual(["verify", "active:false", "verify", "synchronize"]);
  expect(app.errors).toEqual([]);
  app.recovery.dispose();
});

test("a verification completing after the PWA is hidden cannot synchronize", async () => {
  const app = setup();
  app.recovery.resume();
  await settle();
  app.recovery.suspend();
  app.requests[0]!.resolve(true);
  await settle();
  expect(app.calls).toEqual(["verify", "active:false"]);
  expect(app.tasks.size).toBe(0);
  app.recovery.dispose();
});

test("a stuck verification is bounded and a late result cannot satisfy its retry", async () => {
  const app = setup();
  app.recovery.resume();
  await settle();
  app.run(5_000);
  expect(app.errors).toHaveLength(1);
  app.run(1_000);
  await settle();
  app.requests[0]!.resolve(true);
  await settle();
  expect(app.calls).toEqual(["verify", "verify"]);
  app.requests[1]!.resolve(true);
  await settle();
  expect(app.calls).toEqual(["verify", "verify", "synchronize"]);
  app.recovery.dispose();
});

test("failed verification retries while visible and stops when suspended", async () => {
  const app = setup();
  app.recovery.resume();
  await settle();
  app.requests[0]!.resolve(false);
  await settle();
  expect(app.errors).toHaveLength(1);
  app.run(1_000);
  await settle();
  app.requests[1]!.resolve(false);
  await settle();
  expect([...app.tasks.values()].map((entry) => entry.delay)).toEqual([2_000]);
  app.recovery.suspend();
  expect(app.tasks.size).toBe(0);
  app.recovery.dispose();
});

test("disposing an owner invalidates callbacks from its former client", async () => {
  const app = setup();
  app.recovery.resume();
  await settle();
  app.recovery.dispose();
  app.requests[0]!.resolve(true);
  await settle();
  expect(app.calls).toEqual(["verify"]);
  expect(app.tasks.size).toBe(0);
});
