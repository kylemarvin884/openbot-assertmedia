#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeSampleSet } from "../src/fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.mjs");
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "assertmedia-demo-"));
const media = path.join(workdir, "out");
const files = writeSampleSet(media).map((entry) => entry.file);

for (const clip of ["clip-ok.mp4", "clip-black.mp4"]) {
  const source = path.join(root, "fixtures", clip);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(media, clip));
}

const specPath = path.join(workdir, "media.spec.json");
const spec = {
  version: 1,
  file: { minBytes: 1000 },
  image: { minWidth: 300, minHeight: 160, aspect: "16:9", aspectTolerance: 0.02 },
  audio: { minDuration: 1, sampleRate: 44100, channels: 1, maxSilenceRatio: 0.2 },
  video: { minDuration: 1, maxDuration: 3, codec: "h264", width: 320, height: 180 },
};
fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

function run(label, targets) {
  const result = spawnSync(process.execPath, [cli, "check", ...targets, `--spec=${specPath}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  console.log(`\n=== ${label} ===`);
  console.log(result.stdout.trimEnd());
  console.log(`exit code: ${result.status}`);
  return result.status;
}

console.log(`assertmedia demo - generated media in ${path.relative(process.cwd(), media) || media}`);
console.log("spec: minWidth 300, aspect 16:9, audio audible, video h264 320x180 1-3s");

const good = [
  path.join(media, "chart.png"),
  path.join(media, "tone.wav"),
  ...(fs.existsSync(path.join(media, "clip-ok.mp4")) ? [path.join(media, "clip-ok.mp4")] : []),
];
const bad = [
  path.join(media, "blank-frame.png"),
  path.join(media, "transparent.png"),
  path.join(media, "silence.wav"),
  ...(fs.existsSync(path.join(media, "clip-black.mp4")) ? [path.join(media, "clip-black.mp4")] : []),
];

const goodCode = run("artifacts that rendered correctly (expected exit 0)", good);
const badCode = run("artifacts a pipeline would have shipped (expected exit 1)", bad);

if (!fs.existsSync(path.join(media, "clip-ok.mp4"))) {
  console.log("\nnote: video fixtures are missing, run `npm run fixtures` (needs ffmpeg once) to include them");
}

console.log(`\nsummary: good=${goodCode} bad=${badCode}`);
const expected = goodCode === 0 && badCode === 1;
console.log(expected ? "demo result: as expected" : "demo result: UNEXPECTED, see output above");

fs.rmSync(workdir, { recursive: true, force: true });
process.exitCode = expected ? 0 : 1;
