import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeMp4 } from "../src/mp4.mjs";
import { probeFile } from "../src/probe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clipOk = path.join(root, "fixtures", "clip-ok.mp4");
const clipBlack = path.join(root, "fixtures", "clip-black.mp4");
const hasClips = fs.existsSync(clipOk) && fs.existsSync(clipBlack);

test("MP4 metadata is read from a real h264 file", { skip: !hasClips && "run npm run fixtures (needs ffmpeg)" }, () => {
  const decoded = decodeMp4(fs.readFileSync(clipOk));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.kind, "video");
  assert.equal(decoded.codec, "h264");
  assert.equal(decoded.width, 320);
  assert.equal(decoded.height, 180);
  assert.equal(decoded.hasAudio, true);
  assert.ok(decoded.duration > 1 && decoded.duration < 3, `duration ${decoded.duration}`);
  assert.equal(decoded.audio.codec, "aac");
});

test("a black clip reports no audio track", { skip: !hasClips && "run npm run fixtures (needs ffmpeg)" }, () => {
  const probe = probeFile(clipBlack);
  assert.equal(probe.kind, "video");
  assert.equal(probe.video.hasAudio, false);
  assert.equal(probe.audio, undefined);
});

test("garbage bytes are rejected instead of guessed", () => {
  const decoded = decodeMp4(Buffer.from("not a media file at all", "latin1"));
  assert.equal(decoded.ok, false);
  assert.match(decoded.reason, /moov|not an MP4/);
});

test("an unknown file type is reported as unknown, not as a pass", () => {
  const file = path.join(os.tmpdir(), `assertmedia-unknown-${process.pid}.txt`);
  fs.writeFileSync(file, "hello", "utf8");
  const probe = probeFile(file);
  assert.equal(probe.kind, "unknown");
  assert.ok(probe.reason);
  fs.rmSync(file, { force: true });
});
