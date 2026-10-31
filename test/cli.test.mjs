import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { gradientPng, silentWav, solidPng, toneWav } from "../src/fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assertmedia-cli-"));
const out = path.join(dir, "out");
fs.mkdirSync(out);

const good = path.join(out, "chart.png");
const blank = path.join(out, "blank.png");
const tone = path.join(out, "tone.wav");
const silence = path.join(out, "silence.wav");
fs.writeFileSync(good, gradientPng({ width: 320, height: 180 }));
fs.writeFileSync(blank, solidPng({ width: 320, height: 180 }));
fs.writeFileSync(tone, toneWav({ duration: 1 }));
fs.writeFileSync(silence, silentWav({ duration: 1 }));

const specPath = path.join(dir, "media.spec.json");
fs.writeFileSync(
  specPath,
  JSON.stringify({
    version: 1,
    image: { minWidth: 300, minHeight: 100 },
    audio: { minDuration: 0.5 },
  }),
);

const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: root, windowsHide: true });

test("check exits 0 when the artifacts are fine", () => {
  const result = run("check", good, tone, `--spec=${specPath}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /image\.blank/);
  assert.match(result.stdout, /-> exit 0/);
});

test("check exits 1 on a flat image and names the check", () => {
  const result = run("check", blank, `--spec=${specPath}`);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+image\.blank/);
});

test("check exits 1 on silent audio", () => {
  const result = run("check", silence, `--spec=${specPath}`);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+audio\.audible/);
});

test("--json is machine readable and carries the exit code", () => {
  const result = run("check", blank, `--spec=${specPath}`, "--json");
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.summary.fail > 0, true);
  const blankCheck = payload.results[0].checks.find((check) => check.id === "image.blank");
  assert.equal(blankCheck.status, "fail");
});

test("options accept both --spec=file and --spec file", () => {
  const spaced = run("check", good, "--spec", specPath);
  assert.equal(spaced.status, 0, spaced.stderr);
});

test("--strict makes an unmeasured file a failure", () => {
  const onlyBytes = path.join(dir, "bytes-only.spec.json");
  fs.writeFileSync(onlyBytes, JSON.stringify({ version: 1, file: { minBytes: 10 } }));
  const loose = run("check", good, `--spec=${onlyBytes}`);
  const strict = run("check", good, `--spec=${onlyBytes}`, "--strict");
  assert.equal(loose.status, 0, "a skip is not a failure without --strict");
  assert.equal(strict.status, 1, "a skip is a failure with --strict");
});

test("a broken spec exits 2 with the offending key", () => {
  const bad = path.join(dir, "bad.spec.json");
  fs.writeFileSync(bad, JSON.stringify({ image: { minWidht: 100 } }));
  const result = run("check", good, `--spec=${bad}`);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown key "image\.minWidht"/);
});

test("a missing --spec exits 2", () => {
  const result = run("check", good);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--spec/);
});

test("an unreadable file exits 2 instead of reporting a pass", () => {
  const result = run("check", path.join(dir, "does-not-exist.png"), `--spec=${specPath}`);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read/);
});

test("init prints a spec that can be fed back in", () => {
  const init = run("init", good);
  assert.equal(init.status, 0, init.stderr);
  const spec = JSON.parse(init.stdout);
  assert.equal(spec.image.width, 320);
  const file = path.join(dir, "generated.spec.json");
  fs.writeFileSync(file, init.stdout);
  const check = run("check", good, `--spec=${file}`);
  assert.equal(check.status, 0, check.stdout);
});

test("--report writes a markdown table", () => {
  const report = path.join(dir, "report.md");
  const result = run("check", blank, `--spec=${specPath}`, `--report=${report}`);
  assert.equal(result.status, 1);
  const text = fs.readFileSync(report, "utf8");
  assert.match(text, /# assertmedia report/);
  assert.match(text, /\| `.*blank.*` \| `image\.blank` \| FAIL \|/);
});

test("probe explains what could not be measured", () => {
  const result = run("probe", good);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pixels png-native/);
  assert.match(result.stdout, /not measured/);
});
