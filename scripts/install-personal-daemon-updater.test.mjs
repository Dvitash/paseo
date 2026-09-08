import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(workflow.jobs.build.if, /github\.repository == 'Dvitash\/paseo'/);
  assert.match(workflow.jobs.build.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow.jobs.build.if, /github\.actor == 'Dvitash'/);
  assert.equal(workflow.jobs.build.uses, "./.github/workflows/personal-build.yml");
  assert.equal(workflow.jobs.build.with.desktop, "none");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});
