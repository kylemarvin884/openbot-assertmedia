import assert from "node:assert/strict";
import test from "node:test";

import { SpecError, exitCodeFor, evaluate, specFromProbe, validateSpec } from "../src/checks.mjs";
import { gradientPng, silentWav, solidPng, toneWav } from "../src/fixtures.mjs";
import { probeFile } from "../src/probe.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assertmedia-checks-"));
const write = (name, buffer) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
};

const goodImage = write("good.png", gradientPng({ width: 100, height: 100 }));
const flatImage = write("flat.png", solidPng({ width: 100, height: 100 }));
const loudAudio = write("loud.wav", toneWav({ duration: 1 }));
const quietAudio = write("quiet.wav", silentWav({ duration: 1 }));

test("a flat image fails the default blank check", () => {
  const result = evaluate(probeFile(flatImage), { version: 1, image: { minWidth: 50 } });
  const blank = result.checks.find((check) => check.id === "image.blank");
  assert.equal(blank.status, "fail");
  assert.equal(result.ok, false);
});

test("allowBlank opts a deliberately flat image out", () => {
  const result = evaluate(probeFile(flatImage), { version: 1, image: { allowBlank: true, minWidth: 50 } });
  assert.equal(result.checks.some((check) => check.id === "image.blank"), false);
  assert.equal(result.ok, true);
});

test("dimension and aspect assertions use real pixels", () => {
  const result = evaluate(probeFile(goodImage), {
    version: 1,
    image: { width: 100, height: 100, aspect: "1:1" },
  });
  assert.equal(result.summary.fail, 0);
});

test("a wrong aspect ratio fails with the measured value", () => {
  const result = evaluate(probeFile(goodImage), { version: 1, image: { aspect: "16:9" } });
  const aspect = result.checks.find((check) => check.id === "image.aspect");
  assert.equal(aspect.status, "fail");
  assert.match(aspect.actual, /^1 \(100x100\)$/);
});

test("silent audio fails by default when audio rules exist", () => {
  const silent = evaluate(probeFile(quietAudio), { version: 1, audio: { minDuration: 0.5 } });
  assert.equal(silent.checks.find((check) => check.id === "audio.audible").status, "fail");

  const loud = evaluate(probeFile(loudAudio), { version: 1, audio: { minDuration: 0.5 } });
  assert.equal(loud.checks.find((check) => check.id === "audio.audible").status, "pass");
});

test("requireAudible:false makes silence acceptable", () => {
  const result = evaluate(probeFile(quietAudio), {
    version: 1,
    audio: { requireAudible: false, channels: 1 },
  });
  assert.equal(result.checks.some((check) => check.id === "audio.audible"), false);
  assert.equal(result.ok, true);
});

test("a spec with no rules for the file kind skips instead of passing", () => {
  const result = evaluate(probeFile(goodImage), { version: 1, audio: { minDuration: 1 } });
  assert.equal(result.checks.some((check) => check.id === "spec.image"), true);
  assert.equal(result.ok, true);
  assert.equal(exitCodeFor([result], { strict: true }), 1);
  assert.equal(exitCodeFor([result]), 0);
});

test("unknown keys are a spec error, not silently ignored", () => {
  assert.throws(() => validateSpec({ image: { minWidht: 100 } }), SpecError);
  assert.throws(() => validateSpec({ images: { minWidth: 100 } }), SpecError);
  assert.throws(() => validateSpec({ image: { aspect: "wide" } }), SpecError);
  assert.throws(() => validateSpec({ version: 2 }), SpecError);
  assert.throws(() => validateSpec({ image: { maxUniformRatio: 1.5 } }), SpecError);
});

test("specFromProbe records what the file currently is", () => {
  const probe = probeFile(goodImage);
  const spec = specFromProbe(probe);
  assert.equal(spec.image.width, 100);
  assert.equal(spec.image.height, 100);
  assert.ok(spec.file.minBytes > 0);
  assert.doesNotThrow(() => validateSpec(spec));
});

test("non-finite measurements become skips, never failures", () => {
  const probe = { path: "x.mp4", bytes: 10, kind: "video", video: { duration: null, width: 320, height: 180, codec: "h264", hasAudio: false, frames: null } };
  const result = evaluate(probe, { version: 1, video: { minDuration: 1, width: 320 } });
  assert.equal(result.checks.find((check) => check.id === "video.minDuration").status, "skip");
  assert.equal(result.checks.find((check) => check.id === "video.width").status, "pass");
  assert.equal(result.checks.find((check) => check.id === "video.blankFrames").status, "skip");
});
