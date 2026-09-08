import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import concurrently from "concurrently";
import {
  assertPortsAvailable,
  buildDevTailnetEnv,
  buildDevTailnetPlan,
  buildTailnetHostnames,
  checkPlatform,
  checkPortFree,
  formatPlanBanner,
  parseCliArgs,
  parseTailscaleStatus,
  runDevTailnet,
  selectDevPorts,
} from "./dev-tailnet.mjs";

describe("contaminated production env isolation", () => {
  const mockRoot = "/workspaces/my-repo";
  const mockTailscaleIp = "100.91.127.7";
  const mockDnsName = "dgx-spark.taild1bcdf.ts.net.";

  it("isolates PASEO_HOME to .dev/paseo-home and overrides seeding/reset vars to undefined", () => {
    const dirtyEnv = {
      HOME: "/home/developer",
      PASEO_HOME: "/home/developer/.paseo",
      PASEO_DEV_SEED_HOME: "/home/developer/.paseo",
      PASEO_DEV_RESET_HOME: "1",
      PASEO_SKIP_DEV_SERVER_BUILD: "1",
      PASEO_LISTEN: "127.0.0.1:6767",
    };

    const options = {
      daemonOnly: false,
      skipBuild: false,
      port: 6768,
      webPort: 8081,
      dryRun: false,
      help: false,
    };

    const env = buildDevTailnetEnv({
      root: mockRoot,
      tailscaleIp: mockTailscaleIp,
      dnsName: mockDnsName,
      options,
      baseEnv: dirtyEnv,
    });

    assert.equal(env.PASEO_HOME, "/workspaces/my-repo/.dev/paseo-home");
    assert.equal(env.PASEO_DEV_MANAGED_HOME, "1");
    assert.equal(env.PASEO_DEV_ROOT, mockRoot);
    assert.equal(env.PASEO_DEV_SEED_HOME, undefined);
    assert.equal(env.PASEO_DEV_RESET_HOME, undefined);
    assert.equal(env.PASEO_LISTEN, "100.91.127.7:6768");
    assert.equal(env.PASEO_DEV_DAEMON_ENDPOINT, "100.91.127.7:6768");
    assert.equal(env.EXPO_PORT, "8081");
    assert.equal(env.PASEO_HOSTNAMES, "dgx-spark.taild1bcdf.ts.net,dgx-spark.taild1bcdf.ts.net.");
    assert.equal(env.PASEO_SKIP_DEV_SERVER_BUILD, "0");
  });

  it("honors explicit --skip-build flag", () => {
    const options = {
      daemonOnly: false,
      skipBuild: true,
      port: 6768,
      webPort: 8081,
      dryRun: false,
      help: false,
    };

    const env = buildDevTailnetEnv({
      root: mockRoot,
      tailscaleIp: mockTailscaleIp,
      dnsName: mockDnsName,
      options,
      baseEnv: {},
    });

    assert.equal(env.PASEO_SKIP_DEV_SERVER_BUILD, "1");
  });

  it("proves actual child process spawned via concurrently does not inherit seeding/reset vars", async () => {
    const origSeed = process.env.PASEO_DEV_SEED_HOME;
    const origReset = process.env.PASEO_DEV_RESET_HOME;

    try {
      process.env.PASEO_DEV_SEED_HOME = "/should/not/reach/child";
      process.env.PASEO_DEV_RESET_HOME = "1";

      const env = buildDevTailnetEnv({
        root: mockRoot,
        tailscaleIp: mockTailscaleIp,
        dnsName: mockDnsName,
        options: {
          daemonOnly: true,
          skipBuild: false,
          port: 6768,
          webPort: 8081,
          dryRun: false,
          help: false,
        },
      });

      // Spawn a real child checking that process.env.PASEO_DEV_SEED_HOME is undefined
      const verifyScript =
        "if (process.env.PASEO_DEV_SEED_HOME !== undefined || process.env.PASEO_DEV_RESET_HOME !== undefined) { process.exit(42); }";

      const runner = concurrently([
        {
          command: `node -e "${verifyScript}"`,
          name: "test-child",
          env,
        },
      ]);

      await runner.result;
    } finally {
      if (origSeed === undefined) delete process.env.PASEO_DEV_SEED_HOME;
      else process.env.PASEO_DEV_SEED_HOME = origSeed;

      if (origReset === undefined) delete process.env.PASEO_DEV_RESET_HOME;
      else process.env.PASEO_DEV_RESET_HOME = origReset;
    }
  });
});

describe("hostname/IP detection", () => {
  it("parses valid Tailscale status with Self.TailscaleIPs and Self.DNSName", () => {
    const statusJson = JSON.stringify({
      BackendState: "Running",
      Self: {
        DNSName: "dgx-spark.taild1bcdf.ts.net.",
        TailscaleIPs: ["100.91.127.7", "fd7a:115c:a1e0::b001:7fbf"],
      },
    });

    const { tailscaleIp, dnsName } = parseTailscaleStatus(statusJson);
    assert.equal(tailscaleIp, "100.91.127.7");
    assert.equal(dnsName, "dgx-spark.taild1bcdf.ts.net.");
  });

  it("buildTailnetHostnames handles trailing dot and without trailing dot", () => {
    assert.equal(
      buildTailnetHostnames("dgx-spark.taild1bcdf.ts.net."),
      "dgx-spark.taild1bcdf.ts.net,dgx-spark.taild1bcdf.ts.net.",
    );
    assert.equal(buildTailnetHostnames("myhost.ts.net"), "myhost.ts.net");
  });

  it("fails cleanly when Tailscale is not running", () => {
    const status = { BackendState: "Stopped" };
    assert.throws(
      () => parseTailscaleStatus(status),
      /Tailscale is not running \(BackendState: "Stopped"\)/,
    );
  });

  it("fails cleanly when Self.TailscaleIPs is missing or not an array", () => {
    const status = {
      BackendState: "Running",
      Self: { DNSName: "host.ts.net" },
    };
    assert.throws(() => parseTailscaleStatus(status), /No Tailscale IPv4 address found/);
  });

  it("fails cleanly when no IPv4 address exists in Self.TailscaleIPs", () => {
    const status = {
      BackendState: "Running",
      Self: {
        DNSName: "host.ts.net",
        TailscaleIPs: ["fd7a:115c:a1e0::1"],
      },
    };
    assert.throws(() => parseTailscaleStatus(status), /No Tailscale IPv4 address found/);
  });

  it("fails cleanly when no DNS name exists", () => {
    const status = {
      BackendState: "Running",
      Self: {
        DNSName: "",
        TailscaleIPs: ["100.91.127.7"],
      },
    };
    assert.throws(() => parseTailscaleStatus(status), /No Tailscale DNS name found/);
  });

  it("fails cleanly on invalid JSON", () => {
    assert.throws(() => parseTailscaleStatus("not json"), /Invalid Tailscale status JSON/);
  });
});

describe("CLI errors and platform validation", () => {
  it("fails on unsupported platforms", () => {
    assert.throws(() => checkPlatform("win32"), /Unsupported platform: "win32"/);
    assert.doesNotThrow(() => checkPlatform("linux"));
    assert.doesNotThrow(() => checkPlatform("darwin"));
  });

  it("prohibits production port 6767 for daemon or web", () => {
    assert.throws(
      () => parseCliArgs(["--port", "6767"]),
      /Port 6767 is reserved for production daemon/,
    );
    assert.throws(
      () => parseCliArgs(["--web-port", "6767"]),
      /Port 6767 is reserved for production daemon/,
    );
  });

  it("rejects invalid or out-of-range port values", () => {
    assert.throws(() => parseCliArgs(["--port", "0"]), /Invalid --port/);
    assert.throws(() => parseCliArgs(["--port", "70000"]), /Invalid --port/);
    assert.throws(() => parseCliArgs(["--port", "not-a-number"]), /Invalid --port/);
    assert.throws(() => parseCliArgs(["--web-port", "abc"]), /Invalid --web-port/);
  });

  it("rejects identical port and web-port when both are enabled", () => {
    assert.throws(
      () => parseCliArgs(["--port", "8080", "--web-port", "8080"]),
      /--port \(8080\) and --web-port \(8080\) cannot be the same/,
    );
  });

  it("allows identical ports when daemon-only is active", () => {
    const opts = parseCliArgs(["--port", "8080", "--web-port", "8080", "--daemon-only"]);
    assert.equal(opts.daemonOnly, true);
    assert.equal(opts.port, 8080);
  });

  it("rejects unknown CLI options", () => {
    assert.throws(() => parseCliArgs(["--unknown-flag"]));
  });

  it("handles help flag", () => {
    const opts = parseCliArgs(["--help"]);
    assert.equal(opts.help, true);
  });
});

describe("safe dry-run and banner formatting", () => {
  it("prints selected free ports without launching processes", async () => {
    let portsChecked = false;
    let concurrentlyCalled = false;
    const probes = [];

    const result = await runDevTailnet(["--dry-run"], {
      log: false,
      checkPlatform: () => {},
      queryTailscaleStatus: () => ({
        tailscaleIp: "100.91.127.7",
        dnsName: "dgx-spark.taild1bcdf.ts.net.",
      }),
      isPortAvailable: async (port) => {
        probes.push(port);
        return port !== 6768 && port !== 8081;
      },
      assertPortsAvailable: async () => {
        portsChecked = true;
      },
      concurrently: () => {
        concurrentlyCalled = true;
        return { result: Promise.resolve() };
      },
      root: "/workspaces/my-repo",
    });

    assert.equal(result.exitCode, 0);
    assert.equal(portsChecked, false);
    assert.equal(concurrentlyCalled, false);
    assert.deepEqual(probes, [6768, 6769, 8081, 8082]);

    const { plan } = result;
    assert.equal(plan.root, "/workspaces/my-repo");
    assert.equal(plan.commands.length, 2);
    assert.equal(plan.commands[0].command, "./scripts/dev-daemon.sh");
    assert.equal(plan.commands[1].command, "./scripts/dev-app.sh");
    assert.equal(plan.browserUrl, "http://dgx-spark.taild1bcdf.ts.net:8082");
    assert.equal(plan.daemonUrl, "http://100.91.127.7:6769");
    assert.equal(plan.env.PASEO_LISTEN, "100.91.127.7:6769");
    assert.equal(plan.env.PASEO_DEV_DAEMON_ENDPOINT, "100.91.127.7:6769");
    assert.equal(plan.env.EXPO_PORT, "8082");

    const banner = formatPlanBanner(plan);
    assert.match(banner, /SSL:\s+off \(HTTP\)/);
    assert.match(banner, /Browser URL:\s+http:\/\/dgx-spark\.taild1bcdf\.ts\.net:8082/);
  });

  it("creates daemon-only plan and banner does not claim daemon port Browser URL", () => {
    const plan = buildDevTailnetPlan({
      root: "/workspaces/my-repo",
      tailscaleIp: "100.91.127.7",
      dnsName: "dgx-spark.taild1bcdf.ts.net.",
      options: {
        daemonOnly: true,
        skipBuild: false,
        port: 6768,
        webPort: 8081,
        dryRun: true,
        help: false,
      },
      baseEnv: {},
    });

    assert.equal(plan.commands.length, 1);
    assert.equal(plan.commands[0].name, "daemon");
    assert.equal(plan.commands[0].command, "./scripts/dev-daemon.sh");
    assert.equal(plan.browserUrl, null);

    const banner = formatPlanBanner(plan);
    assert.match(banner, /Browser URL:\s+disabled \(--daemon-only\)/);
    assert.doesNotMatch(banner, /Browser URL:\s+http:\/\/.*:6768/);
  });
});

describe("launcher wiring and failure exit code handling", () => {
  it("returns non-zero exit code when one command exits 0 but another exits non-zero", async () => {
    const result = await runDevTailnet([], {
      log: false,
      checkPlatform: () => {},
      queryTailscaleStatus: () => ({
        tailscaleIp: "100.91.127.7",
        dnsName: "dgx-spark.taild1bcdf.ts.net.",
      }),
      assertPortsAvailable: async () => {},
      isPortAvailable: async () => true,
      concurrently: () => ({
        result: Promise.reject([
          { command: { name: "daemon" }, exitCode: 0 },
          { command: { name: "web" }, exitCode: 3 },
        ]),
      }),
      root: "/workspaces/my-repo",
    });

    assert.equal(result.exitCode, 3);
  });

  it("falls back to exitCode 1 if no non-zero number is recorded in errors", async () => {
    const result = await runDevTailnet([], {
      log: false,
      checkPlatform: () => {},
      queryTailscaleStatus: () => ({
        tailscaleIp: "100.91.127.7",
        dnsName: "dgx-spark.taild1bcdf.ts.net.",
      }),
      assertPortsAvailable: async () => {},
      isPortAvailable: async () => true,
      concurrently: () => ({
        result: Promise.reject([{ command: { name: "daemon" }, exitCode: null }]),
      }),
      root: "/workspaces/my-repo",
    });

    assert.equal(result.exitCode, 1);
  });

  it("runs a real bounded process that exits non-zero and captures exitCode", async () => {
    const result = await runDevTailnet(["--daemon-only"], {
      log: false,
      checkPlatform: () => {},
      queryTailscaleStatus: () => ({
        tailscaleIp: "100.91.127.7",
        dnsName: "dgx-spark.taild1bcdf.ts.net.",
      }),
      assertPortsAvailable: async () => {},
      isPortAvailable: async () => true,
      concurrently: (commands, opts) => {
        // Replace daemon command with a real node process that exits with code 5
        return concurrently([{ command: "node -e 'process.exit(5)'", name: "test-fail" }], opts);
      },
      root: process.cwd(),
    });

    assert.equal(result.exitCode, 5);
  });
});

describe("real port conflict leaves existing listener alive", () => {
  it("detects daemon port conflict and leaves existing socket server alive", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    assert.equal(server.listening, true);

    await assert.rejects(
      assertPortsAvailable({
        port,
        webPort: 0,
        tailscaleIp: "127.0.0.1",
        daemonOnly: true,
      }),
      (err) => {
        assert.match(
          err.message,
          new RegExp(
            `Port ${port} is already in use on 127\\.0\\.0\\.1\\. Stop your existing dev terminal or choose a different port with --port\\. No processes were stopped\\.`,
          ),
        );
        return true;
      },
    );

    // Verify the existing listener is still alive and operational
    assert.equal(server.listening, true);
    const client = net.connect({ port, host: "127.0.0.1" });
    await new Promise((resolve) => client.once("connect", resolve));
    client.destroy();

    await new Promise((resolve) => server.close(resolve));
  });

  it("detects web port conflict on 0.0.0.0 and leaves existing socket server alive", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    const webPort = server.address().port;

    assert.equal(server.listening, true);

    await assert.rejects(
      assertPortsAvailable({
        port: 0,
        webPort,
        tailscaleIp: "127.0.0.1",
        daemonOnly: false,
      }),
      (err) => {
        assert.match(
          err.message,
          new RegExp(
            `Port ${webPort} is already in use\\. Stop your existing dev terminal or choose a different port with --web-port\\. No processes were stopped\\.`,
          ),
        );
        return true;
      },
    );

    // Verify server is still listening
    assert.equal(server.listening, true);
    await new Promise((resolve) => server.close(resolve));
  });

  it("checkPortFree confirms available port can be bound and cleans up", async () => {
    const isFree = await checkPortFree(0, "127.0.0.1");
    assert.equal(isFree, true);
  });
});

describe("automatic development port selection", () => {
  it("keeps an explicitly requested web port free for the web process", async () => {
    const options = await selectDevPorts(parseCliArgs(["--web-port", "6768"]), async () => true);
    assert.equal(options.port, 6769);
    assert.equal(options.webPort, 6768);
  });

  it("moves the default web port when the daemon explicitly uses it", async () => {
    const options = await selectDevPorts(parseCliArgs(["--port", "8081"]), async () => true);
    assert.equal(options.port, 8081);
    assert.equal(options.webPort, 8082);
  });

  it("never silently moves an explicitly requested occupied port", async () => {
    await assert.rejects(
      selectDevPorts(parseCliArgs(["--port", "6768"]), async () => false),
      /Port 6768 requested by --port is occupied/,
    );
  });

  it("bounds the search instead of scanning forever", async () => {
    const probes = [];
    await assert.rejects(
      selectDevPorts(parseCliArgs([]), async (port) => {
        probes.push(port);
        return false;
      }),
      /No free port found between 6768 and 6867/,
    );
    assert.equal(probes.length, 100);
  });

  it("skips reserved production port and does not probe web ports in daemon-only mode", async () => {
    const probes = [];
    const options = await selectDevPorts(
      { ...parseCliArgs(["--daemon-only"]), port: 6766 },
      async (port) => {
        probes.push(port);
        return port !== 6766;
      },
    );
    assert.deepEqual(probes, [6766, 6768]);
    assert.equal(options.port, 6768);
  });

  it("skips a real occupied port without disturbing its listener", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = server.address().port;
      const options = await selectDevPorts({
        ...parseCliArgs(["--daemon-only"]),
        port,
      });
      assert.ok(options.port > port);
      assert.equal(await checkPortFree(port, "127.0.0.1"), false);
      assert.equal(server.listening, true);
      assert.equal(await checkPortFree(options.port), true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
