#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeSampleSet } from "../src/fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "fixtures");

const written = writeSampleSet(dir);
console.log(`wrote ${written.length} fixture files to ${path.relative(root, dir)}`);

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { windowsHide: true, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    console.log(`skipped video fixtures: ${result.error?.message ?? result.stderr?.trim() ?? "ffmpeg failed"}`);
    return false;
  }
  return true;
}

const clips = [
  [
    "clip-ok.mp4",
    ["-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=1.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart"],
  ],
  [
    "clip-black.mp4",
    ["-f", "lavfi", "-i", "color=c=black:size=320x180:rate=10:duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
  ],
];

for (const [name, args] of clips) {
  const file = path.join(dir, name);
  if (ffmpeg([...args, file])) console.log(`wrote fixtures/${name} (${fs.statSync(file).size} bytes)`);
}
