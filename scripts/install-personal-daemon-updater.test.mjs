import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { load } from "js-yaml";
import { buildUpdaterUnits, quoteSystemd } from "./install-personal-daemon-updater.mjs";

const config = {
  root: "/home/test/paseo personal",
  nodePath: "/opt/node/bin/node",
};

test("updater unit serializes polls and never invokes the live daemon directly", () => {
  const units = buildUpdaterUnits(config, "/opt/node/bin:/usr/bin", "/usr/bin/flock");
  assert.match(units.service, /Type=oneshot/);
  assert.match(units.service, /"\/usr\/bin\/flock" "--nonblock"/);
  assert.match(units.service, /personal-daemon-update\.mjs/);
  assert.match(units.service, /UMask=0077/);
  assert.doesNotMatch(units.service, /restart|daemon start/);
  assert.match(units.timer, /OnUnitInactiveSec=60s/);
  assert.match(units.timer, /Unit=paseo-personal-update.service/);
});

test(
  "generated units pass the native systemd parser",
  { skip: process.platform !== "linux" },
  (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "paseo units-"));
    try {
      const units = buildUpdaterUnits(
        { root, nodePath: process.execPath },
        "/usr/bin",
        "/usr/bin/flock",
      );
      const serviceFile = path.join(root, "paseo-personal-update.service");
      const timerFile = path.join(root, "paseo-personal-update.timer");
      writeFileSync(serviceFile, units.service);
      writeFileSync(timerFile, units.timer);
      const result = spawnSync("systemd-analyze", ["verify", serviceFile, timerFile], {
        encoding: "utf8",
        timeout: 10000,
      });
      if (result.error?.code === "ENOENT") {
        t.skip("systemd-analyze unavailable");
        return;
      }
      assert.equal(result.status, 0, result.stderr || result.error?.message);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("systemd quoting preserves spaces and escapes specifiers", () => {
  assert.equal(quoteSystemd("/a path/%n/$HOME"), '"/a path/%%n/$$HOME"');
  assert.throws(() => quoteSystemd("path\nExecStart=bad"), /single-line/);
  assert.throws(() => quoteSystemd("path\0bad"), /single-line/);
});

test("daemon update requests are manual and owner/main restricted", () => {
  const workflow = load(
    readFileSync(
      new URL("../.github/workflows/personal-update-daemon.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.desktop.default, "none");
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.desktop.options, ["none", "windows-x64"]);
  assert.equal(typeof workflow.on.workflow_dispatch.inputs.request_id, "object");
  assert.match(workflow["run-name"], /Personal update/);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(workflow.jobs.build.if, /github\.repository == 'Dvitash\/paseo'/);
  assert.match(workflow.jobs.build.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow.jobs.build.if, /github\.actor == 'Dvitash'/);
  assert.equal(workflow.jobs.build.uses, "./.github/workflows/personal-build.yml");
  assert.equal(workflow.jobs.build.with.desktop, "${{ inputs.desktop || 'none' }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});
