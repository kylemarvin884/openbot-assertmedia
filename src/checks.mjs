import { blankVerdict } from "./stats.mjs";

export const SPEC_VERSION = 1;

const RULES = {
  file: {
    minBytes: "number",
    maxBytes: "number",
  },
  image: {
    width: "number",
    height: "number",
    minWidth: "number",
    maxWidth: "number",
    minHeight: "number",
    maxHeight: "number",
    aspect: "aspect",
    aspectTolerance: "number",
    minColors: "number",
    maxUniformRatio: "number",
    minStdDev: "number",
    maxTransparentRatio: "number",
    allowBlank: "boolean",
  },
  audio: {
    duration: "duration",
    minDuration: "duration",
    maxDuration: "duration",
    sampleRate: "number",
    channels: "number",
    minRmsDbfs: "number",
    maxPeakDbfs: "number",
    maxSilenceRatio: "number",
    requireAudible: "boolean",
  },
  video: {
    duration: "duration",
    minDuration: "duration",
    maxDuration: "duration",
    width: "number",
    height: "number",
    minWidth: "number",
    maxWidth: "number",
    minHeight: "number",
    maxHeight: "number",
    codec: "codec",
    requireAudio: "boolean",
    maxBlankRatio: "number",
  },
};

const TOP_LEVEL = new Set(["name", "version", "file", "image", "audio", "video"]);

export class SpecError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpecError";
  }
}

export function parseAspect(value) {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(String(value).trim());
  if (!match) throw new SpecError(`aspect must look like "16:9" or a number, got ${JSON.stringify(value)}`);
  const height = Number(match[2]);
  if (!height) throw new SpecError(`aspect ${JSON.stringify(value)} has a zero denominator`);
  return Number(match[1]) / height;
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new SpecError("spec must be a JSON object");

  for (const key of Object.keys(spec)) {
    if (!TOP_LEVEL.has(key)) {
      throw new SpecError(`unknown top-level key "${key}" (allowed: ${[...TOP_LEVEL].join(", ")})`);
    }
  }
  if (spec.version !== undefined && spec.version !== SPEC_VERSION) {
    throw new SpecError(`unsupported spec version ${JSON.stringify(spec.version)} (this build reads version ${SPEC_VERSION})`);
  }

  for (const group of ["file", "image", "audio", "video"]) {
    if (spec[group] === undefined) continue;
    if (!spec[group] || typeof spec[group] !== "object" || Array.isArray(spec[group])) {
      throw new SpecError(`"${group}" must be an object`);
    }
    const rules = RULES[group];
    for (const [key, value] of Object.entries(spec[group])) {
      const type = rules[key];
      if (!type) {
        throw new SpecError(`unknown key "${group}.${key}" (allowed: ${Object.keys(rules).join(", ")})`);
      }
      if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new SpecError(`"${group}.${key}" must be a finite number`);
      }
      if (type === "duration" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        throw new SpecError(`"${group}.${key}" must be a non-negative number of seconds`);
      }
      if (type === "boolean" && typeof value !== "boolean") {
        throw new SpecError(`"${group}.${key}" must be true or false`);
      }
      if (type === "aspect") parseAspect(value);
      if (type === "codec") {
        const ok =
          typeof value === "string" ||
          (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string"));
        if (!ok) throw new SpecError(`"${group}.${key}" must be a string or a non-empty array of strings`);
      }
    }
    if (spec[group].aspectTolerance !== undefined && (spec[group].aspectTolerance < 0 || spec[group].aspectTolerance > 1)) {
      throw new SpecError('"image.aspectTolerance" must be between 0 and 1 (for example 0.02 = 2%)');
    }
    if (spec[group].maxBlankRatio !== undefined && (spec[group].maxBlankRatio < 0 || spec[group].maxBlankRatio > 1)) {
      throw new SpecError('"video.maxBlankRatio" must be between 0 and 1');
    }
    if (spec[group].maxUniformRatio !== undefined && (spec[group].maxUniformRatio < 0 || spec[group].maxUniformRatio > 1)) {
      throw new SpecError('"image.maxUniformRatio" must be between 0 and 1');
    }
    if (spec[group].maxSilenceRatio !== undefined && (spec[group].maxSilenceRatio < 0 || spec[group].maxSilenceRatio > 1)) {
      throw new SpecError('"audio.maxSilenceRatio" must be between 0 and 1');
    }
  }
  return spec;
}

const ok = (id, expected, actual) => ({ id, status: "pass", expected, actual });
const bad = (id, expected, actual) => ({ id, status: "fail", expected, actual });
const skip = (id, reason) => ({ id, status: "skip", expected: null, actual: null, reason });

const fmt = (value, digits = 2) => (Number.isFinite(value) ? String(Number(value.toFixed(digits))) : String(value));
const seconds = (value) => `${fmt(value, 3)}s`;
const db = (value) => (Number.isFinite(value) ? `${fmt(value, 1)} dBFS` : "-inf dBFS");

function numeric(id, actual, expected, { min = null, max = null, exact = null, digits = 3, unit = "" } = {}) {
  if (!Number.isFinite(actual)) return skip(id, "value not available for this file");
  const shown = `${fmt(actual, digits)}${unit}`;
  if (exact !== null) {
    const wanted = `${fmt(exact, digits)}${unit}`;
    return Math.abs(actual - exact) <= Math.max(1e-9, Math.abs(exact) * 1e-6)
      ? ok(id, `= ${wanted}`, shown)
      : bad(id, `= ${wanted}`, shown);
  }
  const bounds = [];
  if (min !== null) bounds.push(`>= ${fmt(min, digits)}${unit}`);
  if (max !== null) bounds.push(`<= ${fmt(max, digits)}${unit}`);
  const expectedText = bounds.join(" and ");
  const pass = (min === null || actual >= min) && (max === null || actual <= max);
  return pass ? ok(id, expectedText, shown) : bad(id, expectedText, shown);
}

function evaluateFile(spec, probe) {
  const checks = [];
  if (spec.minBytes !== undefined) checks.push(numeric("file.minBytes", probe.bytes, null, { min: spec.minBytes, digits: 0, unit: " B" }));
  if (spec.maxBytes !== undefined) checks.push(numeric("file.maxBytes", probe.bytes, null, { max: spec.maxBytes, digits: 0, unit: " B" }));
  return checks;
}

function evaluateImage(spec, probe) {
  const image = probe.image;
  if (!image) return [skip("image.decode", probe.unavailable?.[0]?.reason ?? "image could not be decoded")];

  const checks = [];
  const { width, height } = image;
  const dims = `${width}x${height}`;

  if (spec.width !== undefined) checks.push(numeric("image.width", width, null, { exact: spec.width, digits: 0 }));
  if (spec.height !== undefined) checks.push(numeric("image.height", height, null, { exact: spec.height, digits: 0 }));
  if (spec.minWidth !== undefined) checks.push(numeric("image.minWidth", width, null, { min: spec.minWidth, digits: 0 }));
  if (spec.maxWidth !== undefined) checks.push(numeric("image.maxWidth", width, null, { max: spec.maxWidth, digits: 0 }));
  if (spec.minHeight !== undefined) checks.push(numeric("image.minHeight", height, null, { min: spec.minHeight, digits: 0 }));
  if (spec.maxHeight !== undefined) checks.push(numeric("image.maxHeight", height, null, { max: spec.maxHeight, digits: 0 }));

  if (spec.aspect !== undefined) {
    const target = parseAspect(spec.aspect);
    const tolerance = spec.aspectTolerance ?? 0.02;
    const actual = width / height;
    const pass = Math.abs(actual - target) <= target * tolerance;
    const check = pass
      ? ok("image.aspect", `${fmt(target, 3)} +-${(tolerance * 100).toFixed(1)}%`, `${fmt(actual, 3)} (${dims})`)
      : bad("image.aspect", `${fmt(target, 3)} +-${(tolerance * 100).toFixed(1)}%`, `${fmt(actual, 3)} (${dims})`);
    checks.push(check);
  }

  const pixels = image.pixels;
  const needsPixels = ["minColors", "maxUniformRatio", "minStdDev", "maxTransparentRatio"].filter(
    (key) => spec[key] !== undefined,
  );
  const wantsBlank = spec.allowBlank !== true;

  if (!pixels) {
    for (const key of needsPixels) checks.push(skip(`image.${key}`, "pixel statistics unavailable (PNG or ffmpeg required)"));
    if (wantsBlank) checks.push(skip("image.blank", "pixel statistics unavailable (PNG or ffmpeg required)"));
    return checks;
  }

  if (spec.minColors !== undefined) {
    checks.push(numeric("image.minColors", pixels.quantizedColors, null, { min: spec.minColors, digits: 0 }));
  }
  if (spec.maxUniformRatio !== undefined) {
    const ratio = pixels.modalRatio;
    const pass = ratio <= spec.maxUniformRatio;
    checks.push(
      pass
        ? ok("image.maxUniformRatio", `<= ${spec.maxUniformRatio}`, `${(ratio * 100).toFixed(1)}% one colour`)
        : bad("image.maxUniformRatio", `<= ${spec.maxUniformRatio}`, `${(ratio * 100).toFixed(1)}% one colour`),
    );
  }
  if (spec.minStdDev !== undefined) {
    checks.push(numeric("image.minStdDev", pixels.stdDevLuma, null, { min: spec.minStdDev, digits: 2 }));
  }
  if (spec.maxTransparentRatio !== undefined) {
    const pass = pixels.transparentRatio <= spec.maxTransparentRatio;
    checks.push(
      pass
        ? ok("image.maxTransparentRatio", `<= ${spec.maxTransparentRatio}`, `${(pixels.transparentRatio * 100).toFixed(1)}% transparent`)
        : bad("image.maxTransparentRatio", `<= ${spec.maxTransparentRatio}`, `${(pixels.transparentRatio * 100).toFixed(1)}% transparent`),
    );
  }

  if (wantsBlank) {
    const verdict = blankVerdict(pixels);
    const detail = `stdDev ${fmt(pixels.stdDevLuma, 2)}, ${(pixels.modalRatio * 100).toFixed(1)}% one colour`;
    checks.push(
      verdict.blank
        ? { id: "image.blank", status: "fail", expected: "image has visible content", actual: `blank (${verdict.reasons.join("; ")})` }
        : ok("image.blank", "image has visible content", detail),
    );
  }

  return checks;
}

function evaluateAudio(spec, probe) {
  const audio = probe.audio;
  if (!audio) return [skip("audio.decode", probe.unavailable?.[0]?.reason ?? "audio could not be decoded")];

  const checks = [];
  if (spec.duration !== undefined) checks.push(numeric("audio.duration", audio.duration, null, { exact: spec.duration, digits: 3, unit: "s" }));
  if (spec.minDuration !== undefined) checks.push(numeric("audio.minDuration", audio.duration, null, { min: spec.minDuration, digits: 3, unit: "s" }));
  if (spec.maxDuration !== undefined) checks.push(numeric("audio.maxDuration", audio.duration, null, { max: spec.maxDuration, digits: 3, unit: "s" }));
  if (spec.sampleRate !== undefined) checks.push(numeric("audio.sampleRate", audio.sampleRate, null, { exact: spec.sampleRate, digits: 0, unit: " Hz" }));
  if (spec.channels !== undefined) checks.push(numeric("audio.channels", audio.channels, null, { exact: spec.channels, digits: 0 }));

  const audible = spec.requireAudible ?? (spec.minRmsDbfs === undefined);
  const needsLevel = spec.minRmsDbfs !== undefined || spec.maxPeakDbfs !== undefined || audible;

  if (needsLevel && !audio.measured) {
    if (spec.minRmsDbfs !== undefined) checks.push(skip("audio.minRmsDbfs", audio.levelReason ?? "level not measured (ffmpeg required for this container)"));
    if (spec.maxPeakDbfs !== undefined) checks.push(skip("audio.maxPeakDbfs", audio.levelReason ?? "level not measured (ffmpeg required for this container)"));
    if (audible) checks.push(skip("audio.audible", audio.levelReason ?? "level not measured (ffmpeg required for this container)"));
  } else if (audio.measured) {
    if (spec.minRmsDbfs !== undefined) {
      checks.push(
        audio.rmsDbfs >= spec.minRmsDbfs
          ? ok("audio.minRmsDbfs", `>= ${spec.minRmsDbfs} dBFS`, db(audio.rmsDbfs))
          : bad("audio.minRmsDbfs", `>= ${spec.minRmsDbfs} dBFS`, db(audio.rmsDbfs)),
      );
    }
    if (spec.maxPeakDbfs !== undefined) {
      checks.push(
        audio.peakDbfs <= spec.maxPeakDbfs
          ? ok("audio.maxPeakDbfs", `<= ${spec.maxPeakDbfs} dBFS`, db(audio.peakDbfs))
          : bad("audio.maxPeakDbfs", `<= ${spec.maxPeakDbfs} dBFS`, db(audio.peakDbfs)),
      );
    }
    if (audible) {
      checks.push(
        audio.rmsDbfs > -60
          ? ok("audio.audible", "> -60 dBFS RMS", db(audio.rmsDbfs))
          : bad("audio.audible", "> -60 dBFS RMS", `${db(audio.rmsDbfs)} (silent)`),
      );
    }
  }

  if (spec.maxSilenceRatio !== undefined) {
    if (audio.silenceRatio === undefined || audio.silenceRatio === null) {
      checks.push(skip("audio.maxSilenceRatio", audio.silenceReason ?? "silence windows not measured for this container"));
    } else {
      const pass = audio.silenceRatio <= spec.maxSilenceRatio;
      const shown = `${(audio.silenceRatio * 100).toFixed(1)}% of 100ms windows below -50 dBFS`;
      checks.push(
        pass ? ok("audio.maxSilenceRatio", `<= ${spec.maxSilenceRatio}`, shown) : bad("audio.maxSilenceRatio", `<= ${spec.maxSilenceRatio}`, shown),
      );
    }
  }

  return checks;
}

function evaluateVideo(spec, probe) {
  const video = probe.video;
  if (!video) return [skip("video.decode", probe.unavailable?.[0]?.reason ?? "video could not be decoded")];

  const checks = [];
  if (spec.duration !== undefined) checks.push(numeric("video.duration", video.duration, null, { exact: spec.duration, digits: 3, unit: "s" }));
  if (spec.minDuration !== undefined) checks.push(numeric("video.minDuration", video.duration, null, { min: spec.minDuration, digits: 3, unit: "s" }));
  if (spec.maxDuration !== undefined) checks.push(numeric("video.maxDuration", video.duration, null, { max: spec.maxDuration, digits: 3, unit: "s" }));
  if (spec.width !== undefined) checks.push(numeric("video.width", video.width, null, { exact: spec.width, digits: 0 }));
  if (spec.height !== undefined) checks.push(numeric("video.height", video.height, null, { exact: spec.height, digits: 0 }));
  if (spec.minWidth !== undefined) checks.push(numeric("video.minWidth", video.width, null, { min: spec.minWidth, digits: 0 }));
  if (spec.maxWidth !== undefined) checks.push(numeric("video.maxWidth", video.width, null, { max: spec.maxWidth, digits: 0 }));
  if (spec.minHeight !== undefined) checks.push(numeric("video.minHeight", video.height, null, { min: spec.minHeight, digits: 0 }));
  if (spec.maxHeight !== undefined) checks.push(numeric("video.maxHeight", video.height, null, { max: spec.maxHeight, digits: 0 }));

  if (spec.codec !== undefined) {
    const wanted = (Array.isArray(spec.codec) ? spec.codec : [spec.codec]).map((item) => item.toLowerCase());
    const actual = String(video.codec ?? "").toLowerCase();
    const pass = wanted.includes(actual);
    checks.push(
      pass
        ? ok("video.codec", wanted.join(" or "), actual || "unknown")
        : bad("video.codec", wanted.join(" or "), actual || "unknown"),
    );
  }

  if (spec.requireAudio !== undefined) {
    const pass = video.hasAudio === spec.requireAudio;
    const shown = video.hasAudio ? `audio ${video.audio?.codec ?? "present"}` : "no audio track";
    checks.push(
      pass
        ? ok("video.requireAudio", spec.requireAudio ? "audio track present" : "no audio track", shown)
        : bad("video.requireAudio", spec.requireAudio ? "audio track present" : "no audio track", shown),
    );
  }

  const frames = video.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    checks.push(skip("video.blankFrames", video.frameReason ?? "frame sampling needs ffmpeg"));
  } else {
    const blankFrames = frames.filter((frame) => frame.blank);
    const ratio = blankFrames.length / frames.length;
    const limit = spec.maxBlankRatio ?? (frames.length > 0 ? 1 : 0);
    const pass = spec.maxBlankRatio === undefined ? blankFrames.length < frames.length : ratio <= limit;
    const shown = `${blankFrames.length}/${frames.length} sampled frames blank`;
    checks.push(
      pass ? ok("video.blankFrames", spec.maxBlankRatio === undefined ? "not every frame is blank" : `blank ratio <= ${limit}`, shown)
        : bad("video.blankFrames", spec.maxBlankRatio === undefined ? "not every frame is blank" : `blank ratio <= ${limit}`, shown),
    );
  }

  return checks;
}

export function evaluate(probe, rawSpec) {
  const spec = validateSpec(rawSpec);
  const checks = [...evaluateFile(spec.file ?? {}, probe)];
  const addGroup = (group, evaluateGroup) => {
    const before = checks.length;
    checks.push(...evaluateGroup());
    if (checks.length === before) {
      checks.push(skip(`spec.${group}`, `spec has no measured "${group}" rules for this file`));
    }
  };

  if (probe.kind === "image") {
    if (spec.image) addGroup("image", () => evaluateImage(spec.image, probe));
    else checks.push(skip("spec.image", 'spec has no "image" rules for this file'));
  } else if (probe.kind === "audio") {
    if (spec.audio) addGroup("audio", () => evaluateAudio(spec.audio, probe));
    else checks.push(skip("spec.audio", 'spec has no "audio" rules for this file'));
  } else if (probe.kind === "video") {
    if (spec.video) addGroup("video", () => evaluateVideo(spec.video, probe));
    else checks.push(skip("spec.video", 'spec has no "video" rules for this file'));
    if (spec.audio) {
      if (probe.audio) addGroup("audio", () => evaluateAudio(spec.audio, probe));
      else checks.push(skip("spec.audio", "video has no audio track to measure"));
    }
  } else {
    checks.push(skip("probe.kind", probe.reason ?? "file type not recognised"));
  }

  const summary = {
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length,
    skip: checks.filter((check) => check.status === "skip").length,
  };

  return {
    path: probe.path,
    kind: probe.kind,
    format: probe.container ?? probe.format,
    bytes: probe.bytes,
    checks,
    summary,
    ok: summary.fail === 0,
  };
}

export function exitCodeFor(results, { strict = false } = {}) {
  if (results.some((result) => result.summary.fail > 0)) return 1;
  if (strict && results.some((result) => result.summary.skip > 0)) return 1;
  return 0;
}

/**
 * Derive a starting spec from an observed artifact. It records what this file
 * currently is, not what it should be — tighten the numbers before relying on it.
 */
export function specFromProbe(probe) {
  const spec = { version: SPEC_VERSION, file: { minBytes: Math.max(1, Math.floor(probe.bytes * 0.5)) } };
  const span = (value) => ({
    minDuration: Math.max(0, Number((value * 0.95).toFixed(3))),
    maxDuration: Number((value * 1.05).toFixed(3)) + 0.001,
  });

  if (probe.kind === "image" && probe.image) {
    spec.image = { width: probe.image.width, height: probe.image.height, allowBlank: false };
  } else if (probe.kind === "video" && probe.video) {
    spec.video = { width: probe.video.width, height: probe.video.height, requireAudio: probe.video.hasAudio };
    if (probe.video.codec) spec.video.codec = probe.video.codec;
    if (Number.isFinite(probe.video.duration)) Object.assign(spec.video, span(probe.video.duration));
  } else if (probe.kind === "audio" && probe.audio) {
    spec.audio = { channels: probe.audio.channels, sampleRate: probe.audio.sampleRate };
    if (Number.isFinite(probe.audio.duration)) Object.assign(spec.audio, span(probe.audio.duration));
  } else {
    throw new SpecError(`cannot derive a spec from ${probe.path}: ${probe.reason ?? probe.kind}`);
  }
  return spec;
}
