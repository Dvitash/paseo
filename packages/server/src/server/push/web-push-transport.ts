import { validatePushEndpoint } from "./web-push-validation.js";

export interface WebPushTransportRequest {
  endpoint: string;
  method: string;
  headers: Record<string, string | number>;
  body: Buffer | null;
  timeoutMs?: number;
}

export interface WebPushTransportResponse {
  statusCode: number;
}

export interface WebPushTransport {
  send(request: WebPushTransportRequest): Promise<WebPushTransportResponse>;
}

/**
 * Delivery error for push notification operations.
 *
 * Requirements:
 * - Never includes sensitive properties (endpoints, keys, headers, response bodies)
 *   to avoid leaking sensitive data into generic Pino error logs.
 */
export class WebPushDeliveryError extends Error {
  readonly statusCode?: number;

  constructor(
    message: string,
    params?: {
      statusCode?: number;
    },
  ) {
    super(message);
    this.name = "WebPushDeliveryError";
    this.statusCode = params?.statusCode;
  }
}

/**
 * Standard production HTTPS transport for Web Push using fetch.
 *
 * Requirements:
 * - Enforces HTTPS and port 443 through endpoint validation.
 * - Enforces redirect: 'error' (standard fetch rejects 3xx redirects).
 * - Enforces absolute request deadline via AbortSignal.timeout.
 * - Memory bounded: cancels response.body after headers are received (only status is needed).
 * - No raw response headers, endpoints, or response bodies in user-facing errors.
 * - Rejects on non-2xx HTTP response codes.
 */
export class HttpsWebPushTransport implements WebPushTransport {
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = 10_000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async send(request: WebPushTransportRequest): Promise<WebPushTransportResponse> {
    validatePushEndpoint(request.endpoint);
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      headers.set(key, String(value));
    }

    const body = request.body ? new Uint8Array(request.body) : undefined;

    let response: Response;
    try {
      response = await fetch(request.endpoint, {
        method: request.method || "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof WebPushDeliveryError) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new WebPushDeliveryError(`Push service request timed out after ${timeoutMs}ms`);
      }
      throw new WebPushDeliveryError(`Push service request failed: ${err.message}`);
    }

    // Cancel response body immediately after receiving headers to bound memory
    try {
      await response.body?.cancel();
    } catch {
      // Ignore body cancellation failures
    }

    if (!response.ok) {
      throw new WebPushDeliveryError(
        `Push service rejected notification with status ${response.status}`,
        { statusCode: response.status },
      );
    }

    return { statusCode: response.status };
  }
}
