import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { decodeMp4 } from "./mp4.mjs";
import { decodePng, PNG_SIGNATURE } from "./png.mjs";
import { blankVerdict, imageStats } from "./stats.mjs";
import { decodeWav } from "./wav.mjs";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".tiff"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".aac"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);

export function supportedExtensions() {
  return new Set([...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);
}

let toolCache = null;
export function availableTools() {
  if (toolCache) return toolCache;
  const has = (binary) => {
    const result = spawnSync(binary, ["-version"], { stdio: "ignore", windowsHide: true });
    return !result.error && result.status === 0;
  };
  toolCache = { ffmpeg: has("ffmpeg"), ffprobe: has("ffprobe") };
  return toolCache;
}

function detect(buf, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf.toString("latin1", 0, 4) === "GIF8") return "gif";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF") {
    const format = buf.toString("latin1", 8, 12);
    if (format === "WAVE") return "wav";
    if (format === "WEBP") return "webp";
    return "riff";
  }
  if (buf.length >= 8) {
    const boxType = buf.toString("latin1", 4, 8);
    if (["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(boxType)) return "mp4";
  }
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return "ebml";
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "OggS") return "ogg";
  if (buf.length >= 3 && (buf.toString("latin1", 0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) {
    return "mp3";
  }
  if (IMAGE_EXTENSIONS.has(ext)) return "image?";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio?";
  if (VIDEO_EXTENSIONS.has(ext)) return "video?";
  return "unknown";
}

function jpegSize(buf) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buf) {
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8X" && buf.length >= 30) {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (chunk === "VP8L" && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function gifSize(buf) {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function ffprobeJson(filePath) {
  if (!availableTools().ffprobe) return null;
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function ffmpegPixels(filePath, size = 64) {
  if (!availableTools().ffmpeg) return null;
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", filePath, "-vf", `scale=${size}:${size}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
    { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  if (result.error || result.status !== 0) return null;
  const buf = result.stdout;
  if (!buf || buf.length !== size * size * 4) return null;
  return { rgba: buf, width: size, height: size, source: `ffmpeg@${size}x${size}` };
}

/**
 * Sample up to `maxFrames` frames at `fps` and describe each one. Sampling is
 * coarse on purpose: the question is "is there anything on screen", not codec
 * quality.
 */
function ffmpegFrames(filePath, { fps = 1, size = 64, maxFrames = 10 } = {}) {
  if (!availableTools().ffmpeg) return null;
  const result = spawnSync(
    "ffmpeg",
    [
      "-v", "error",
      "-i", filePath,
      "-vf", `fps=${fps},scale=${size}:${size}`,
      "-frames:v", String(maxFrames),
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  if (result.error || result.status !== 0) return null;
  const frameBytes = size * size * 4;
  const count = Math.floor((result.stdout?.length ?? 0) / frameBytes);
  if (!count) return null;

  const frames = [];
  for (let index = 0; index < count; index += 1) {
    const rgba = result.stdout.subarray(index * frameBytes, (index + 1) * frameBytes);
    const stats = imageStats(rgba, size, size);
    frames.push({
      t: Number((index / fps).toFixed(2)),
      ...stats,
      blank: blankVerdict(stats).blank,
      sample: `${size}x${size}`,
    });
  }
  return frames;
}

function ffmpegVolume(filePath) {
  if (!availableTools().ffmpeg) return null;
  const result = spawnSync(
    "ffmpeg",
    ["-v", "info", "-i", filePath, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  const text = result.stderr ?? "";
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(text);
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(text);
  if (!mean && !peak) return null;
  return {
    rmsDbfs: mean ? Number(mean[1]) : null,
    peakDbfs: peak ? Number(peak[1]) : null,
  };
}

function probeFromFfprobe(filePath) {
  const data = ffprobeJson(filePath);
  if (!data) return null;
  const streams = data.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration);
  const base = { source: "ffprobe", container: data.format?.format_name ?? null };

  if (video) {
    return {
      ...base,
      kind: "video",
      video: {
        duration: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
        width: video.width ?? null,
        height: video.height ?? null,
        codec: video.codec_name ?? null,
        hasAudio: Boolean(audio),
        audio: audio ? { codec: audio.codec_name ?? null, channels: audio.channels ?? null, sampleRate: Number(audio.sample_rate) || null } : null,
      },
    };
  }
  if (audio) {
    return {
      ...base,
      kind: "audio",
      audio: {
        duration: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
        sampleRate: Number(audio.sample_rate) || null,
        channels: audio.channels ?? null,
        codec: audio.codec_name ?? null,
        measured: false,
      },
    };
  }
  return null;
}

/**
 * Inspect one file. Native decoders handle PNG, WAV and MP4/MOV with no
 * dependency; ffmpeg/ffprobe are used only for formats that need them, and
 * every skipped measurement is recorded in `unavailable`.
 */
export function probeFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const format = detect(buf, filePath);
  const result = { path: filePath, bytes: buf.length, format, kind: "unknown", unavailable: [] };

  if (format === "png") {
    const decoded = decodePng(buf);
    if (decoded.ok) {
      result.kind = "image";
      result.container = "png";
      result.image = {
        width: decoded.width,
        height: decoded.height,
        pixels: imageStats(decoded.rgba, decoded.width, decoded.height),
        pixelSource: "png-native",
      };
      return result;
    }
    result.unavailable.push({ id: "image.decode", reason: decoded.reason });
  }

  if (format === "wav") {
    const decoded = decodeWav(buf);
    if (decoded.ok) {
      result.kind = "audio";
      result.container = "wav";
      result.audio = { ...decoded, measured: true };
      return result;
    }
    result.unavailable.push({ id: "audio.decode", reason: decoded.reason });
  }

  if (format === "mp4") {
    const decoded = decodeMp4(buf);
    if (decoded.ok) {
      result.container = decoded.container;
      if (decoded.kind === "video") {
        result.kind = "video";
        const frames = ffmpegFrames(filePath);
        result.video = {
          duration: decoded.duration,
          width: decoded.width,
          height: decoded.height,
          codec: decoded.codec,
          hasAudio: decoded.hasAudio,
          audio: decoded.audio,
          frames,
          frameReason: frames ? undefined : "frame sampling needs ffmpeg (not found, or decode failed)",
        };
        if (decoded.hasAudio) {
          const level = ffmpegVolume(filePath);
          result.audio = {
            codec: decoded.audio?.codec ?? null,
            channels: decoded.audio?.channels ?? null,
            sampleRate: decoded.audio?.sampleRate ?? null,
            duration: decoded.duration,
            measured: Boolean(level),
            levelReason: level ? undefined : "audio level needs ffmpeg",
            silenceReason: "silence windows are only measured from WAV",
            ...(level ?? {}),
          };
        }
      } else {
        result.kind = "audio";
        const level = ffmpegVolume(filePath);
        result.audio = {
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          codec: decoded.codec,
          measured: Boolean(level),
          levelReason: level ? undefined : "audio level needs ffmpeg",
          silenceReason: "silence windows are only measured from WAV",
          ...(level ?? {}),
        };
      }
      return result;
    }
    result.unavailable.push({ id: "video.decode", reason: decoded.reason });
  }

  const size =
    format === "jpeg"
      ? jpegSize(buf)
      : format === "webp"
        ? webpSize(buf)
        : format === "gif"
          ? gifSize(buf)
          : null;

  if (size && size.width) {
    const pixels = ffmpegPixels(filePath);
    result.kind = "image";
    result.container = format;
    result.image = {
      width: size.width,
      height: size.height,
      pixels: pixels ? imageStats(pixels.rgba, pixels.width, pixels.height) : null,
      pixelSource: pixels ? pixels.source : null,
    };
    if (!pixels) {
      result.unavailable.push({ id: "image.pixels", reason: "pixel statistics need PNG or ffmpeg" });
    }
    return result;
  }

  const fallback = probeFromFfprobe(filePath);
  if (fallback) {
    Object.assign(result, fallback);
    if (result.kind === "video") {
      result.unavailable.push({ id: "video.frames", reason: "frame sampling is not implemented; metadata came from ffprobe" });
    }
    return result;
  }

  result.reason = "format not recognised, and ffprobe is unavailable";
  return result;
}

export function probeSummary(probe) {
  if (probe.kind === "image" && probe.image) {
    const source = probe.image.pixelSource ? `, pixels ${probe.image.pixelSource}` : ", pixels unavailable";
    return `image ${probe.image.width}x${probe.image.height} ${probe.container}${source}`;
  }
  if (probe.kind === "audio" && probe.audio) {
    const measured = probe.audio.measured ? "" : ", level unmeasured";
    return `audio ${probe.audio.duration ?? "?"}s ${probe.audio.codec ?? probe.container} ${probe.audio.sampleRate ?? "?"}Hz ${probe.audio.channels ?? "?"}ch${measured}`;
  }
  if (probe.kind === "video" && probe.video) {
    const audio = probe.video.hasAudio ? `, audio ${probe.video.audio?.codec ?? "yes"}` : ", no audio";
    return `video ${probe.video.duration ?? "?"}s ${probe.video.width ?? "?"}x${probe.video.height ?? "?"} ${probe.video.codec ?? "?"}${audio}`;
  }
  return probe.reason ?? `unrecognised (${probe.format})`;
}
