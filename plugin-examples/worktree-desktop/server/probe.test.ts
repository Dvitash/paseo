import http from "node:http";
import { describe, expect, it } from "vitest";
import { derivePorts, probeDesktopReadiness, probeHttpPort } from "./probe";

function serverPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return address.port;
}

describe("derivePorts", () => {
  it("derives correct https, proxy, and backend ports for valid display", () => {
    const ports = derivePorts(109);
    expect(ports).toEqual({
      https: 20109,
      proxy: 18109,
      backend: 28109,
    });
  });

  it("handles boundary display numbers 103 and 999", () => {
    expect(derivePorts(103)).toEqual({
      https: 20103,
      proxy: 18103,
      backend: 28103,
    });

    expect(derivePorts(999)).toEqual({
      https: 20999,
      proxy: 18999,
      backend: 28999,
    });
  });

  it("throws for display numbers out of 103..999 range or non-integers", () => {
    expect(() => derivePorts(102)).toThrow(/between 103 and 999/);
    expect(() => derivePorts(1000)).toThrow(/between 103 and 999/);
    expect(() => derivePorts(105.5)).toThrow(/between 103 and 999/);
  });
});

describe("probeHttpPort", () => {
  it("resolves true when server responds with HTTP 200", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = serverPort(server);

    try {
      const result = await probeHttpPort(port);
      expect(result).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("resolves false when server responds with non-200 status", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = serverPort(server);

    try {
      const result = await probeHttpPort(port);
      expect(result).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("resolves false within its deadline when the server never sends headers", async () => {
    const server = http.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      expect(await probeHttpPort(serverPort(server), { timeoutMs: 50 })).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends custom Host header when provided", async () => {
    let receivedHost: string | undefined;
    const server = http.createServer((req, res) => {
      receivedHost = req.headers.host;
      res.writeHead(200);
      res.end("OK");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = serverPort(server);

    try {
      await probeHttpPort(port, { hostHeader: "custom.domain.tailnet.ts.net:20109" });
      expect(receivedHost).toBe("custom.domain.tailnet.ts.net:20109");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});

describe("probeDesktopReadiness", () => {
  it("probes proxy port with host header and returns true on HTTP 200", async () => {
    const probeCalls: Array<{ port: number; hostHeader?: string }> = [];
    const mockProbe = async (port: number, options?: { hostHeader?: string }) => {
      probeCalls.push({ port, hostHeader: options?.hostHeader });
      return port === 18109; // Proxy port for display 109
    };

    const isReady = await probeDesktopReadiness(
      109,
      "https://spark.tailnet.ts.net:20109/",
      mockProbe,
    );
    expect(isReady).toBe(true);
    expect(probeCalls).toEqual([{ port: 18109, hostHeader: "spark.tailnet.ts.net:20109" }]);
  });

  it("returns false without fallback when proxy probe fails", async () => {
    const probeCalls: number[] = [];
    const mockProbe = async (port: number) => {
      probeCalls.push(port);
      return false;
    };

    const isReady = await probeDesktopReadiness(
      109,
      "https://spark.tailnet.ts.net:20109/",
      mockProbe,
    );
    expect(isReady).toBe(false);
    expect(probeCalls).toEqual([18109]); // Only proxy probed, no backend fallback
  });
});
