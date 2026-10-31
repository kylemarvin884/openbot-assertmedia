import fs from "node:fs";
import path from "node:path";

import { encodeIndexedPng, encodePng } from "./png.mjs";

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

/** A deterministic image with real variation: the "this rendered fine" case. */
export function gradientPng({ width = 320, height = 180 } = {}) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = clamp((x / Math.max(1, width - 1)) * 220 + 20);
      rgba[offset + 1] = clamp((y / Math.max(1, height - 1)) * 180 + 40);
      rgba[offset + 2] = clamp(90 + 80 * Math.sin(x / 24));
      rgba[offset + 3] = 255;
    }
  }
  return encodePng({ width, height, rgba });
}

/** One flat colour: what a chart looks like when no data reached it. */
export function solidPng({ width = 200, height = 120, color = [255, 255, 255, 255] } = {}) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = color[0];
    rgba[i * 4 + 1] = color[1];
    rgba[i * 4 + 2] = color[2];
    rgba[i * 4 + 3] = color[3] ?? 255;
  }
  return encodePng({ width, height, rgba });
}

/** Fully transparent: a render that "succeeded" and produced nothing visible. */
export function transparentPng({ width = 120, height = 120 } = {}) {
  return solidPng({ width, height, color: [0, 0, 0, 0] });
}

/** Palette PNG with a few colours, to exercise the indexed decode path. */
export function palettePng({ width = 64, height = 64 } = {}) {
  const palette = [255, 255, 255, 30, 30, 30, 220, 40, 40, 40, 120, 220];
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      indices[y * width + x] = Math.floor((x / 8) % 4);
    }
  }
  return encodeIndexedPng({ width, height, indices, palette });
}

function wavBuffer({ duration, sampleRate, channels, bitsPerSample, sampleAt }) {
  const frames = Math.max(0, Math.round(duration * sampleRate));
  const blockAlign = channels * (bitsPerSample / 8);
  const data = Buffer.alloc(frames * blockAlign);

  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-1, Math.min(1, sampleAt(frame / sampleRate, channel)));
      const offset = frame * blockAlign + channel * (bitsPerSample / 8);
      if (bitsPerSample === 8) data[offset] = clamp(value * 127 + 128);
      else if (bitsPerSample === 16) data.writeInt16LE(Math.round(value * 32767), offset);
      else throw new Error(`${bitsPerSample}-bit fixtures are not supported`);
    }
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/** Audible test tone. */
export function toneWav({ duration = 2, sampleRate = 44100, channels = 1, frequency = 440, amplitude = 0.4 } = {}) {
  return wavBuffer({
    duration,
    sampleRate,
    channels,
    bitsPerSample: 16,
    sampleAt: (seconds) => amplitude * Math.sin(2 * Math.PI * frequency * seconds),
  });
}

/** Digital silence: TTS/agent audio that "generated successfully". */
export function silentWav({ duration = 2, sampleRate = 44100, channels = 1 } = {}) {
  return wavBuffer({ duration, sampleRate, channels, bitsPerSample: 16, sampleAt: () => 0 });
}

/** Write the dependency-free sample set. Returns the files written. */
export function writeSampleSet(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ["chart.png", gradientPng({ width: 320, height: 180 })],
    ["blank-frame.png", solidPng({ width: 320, height: 180 })],
    ["transparent.png", transparentPng({ width: 160, height: 160 })],
    ["palette.png", palettePng({ width: 64, height: 64 })],
    ["tone.wav", toneWav({ duration: 2 })],
    ["silence.wav", silentWav({ duration: 2 })],
  ].map(([name, buffer]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, buffer);
    return { name, file, bytes: buffer.length };
  });
  return files;
}
