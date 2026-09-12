import http from "node:http";
import type { DerivedPorts, ProbeOptions } from "./types";

export function derivePorts(display: number): DerivedPorts {
  if (!Number.isInteger(display) || display < 103 || display > 999) {
    throw new Error(`Invalid display number ${display}: must be an integer between 103 and 999`);
  }
  return {
    https: 20000 + display,
    proxy: 18000 + display,
    backend: 28000 + display,
  };
}

export function probeHttpPort(port: number, options?: ProbeOptions): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 1500;
  const host = options?.host ?? "127.0.0.1";

  return new Promise<boolean>((resolve) => {
    let settled = false;
    function finish(value: boolean) {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    }

    const headers: Record<string, string> = {};
    if (options?.hostHeader) {
      headers.Host = options.hostHeader;
    }

    const req = http.request(
      {
        hostname: host,
        port,
        path: "/",
        method: "GET",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        finish(res.statusCode === 200);
      },
    );

    const deadline = setTimeout(() => {
      req.destroy();
      finish(false);
    }, timeoutMs);
    req.once("close", () => clearTimeout(deadline));

    req.on("error", () => {
      finish(false);
    });

    req.end();
  });
}

export function probeDesktopReadiness(
  display: number,
  browserUrl: string,
  probeFn: (port: number, options?: ProbeOptions) => Promise<boolean> = probeHttpPort,
): Promise<boolean> {
  const ports = derivePorts(display);

  const hostHeader = new URL(browserUrl).host;

  // Probe proxy port (18000 + display) with Host header.
  // The proxy is the authoritative endpoint that injects /spark-mouse.js and handles authentication.
  return probeFn(ports.proxy, { hostHeader });
}
