import assert from "node:assert/strict";
import test from "node:test";

import { decodeWav } from "../src/wav.mjs";
import { silentWav, toneWav } from "../src/fixtures.mjs";

test("tone is audible and fully occupied", () => {
  const decoded = decodeWav(toneWav({ duration: 1, frequency: 440, amplitude: 0.5 }));
  assert.equal(decoded.ok, true);
  assert.ok(Math.abs(decoded.duration - 1) < 0.01);
  assert.equal(decoded.sampleRate, 44100);
  assert.equal(decoded.channels, 1);
  assert.ok(decoded.rmsDbfs > -20, `expected audible RMS, got ${decoded.rmsDbfs}`);
  assert.ok(decoded.peakDbfs < 0);
  assert.equal(decoded.silenceRatio, 0);
});

test("digital silence is caught", () => {
  const decoded = decodeWav(silentWav({ duration: 1 }));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.rmsDbfs, -Infinity);
  assert.equal(decoded.silenceRatio, 1);
});

test("stereo layout is reported", () => {
  const decoded = decodeWav(toneWav({ duration: 0.5, channels: 2, sampleRate: 8000 }));
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.sampleRate, 8000);
});

test("non-WAV input is rejected with a reason", () => {
  const decoded = decodeWav(Buffer.from("RIFFxxxxAVI ", "latin1"));
  assert.equal(decoded.ok, false);
  assert.match(decoded.reason, /not a RIFF\/WAVE/);
});

test("a WAV without a data chunk is rejected", () => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  const decoded = decodeWav(header);
  assert.equal(decoded.ok, false);
  assert.match(decoded.reason, /data chunk/);
});
