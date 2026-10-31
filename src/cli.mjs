#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { SpecError, evaluate, exitCodeFor, specFromProbe, validateSpec } from "./checks.mjs";
import { availableTools, probeFile, probeSummary, supportedExtensions } from "./probe.mjs";
import { formatJson, formatMarkdown, formatText } from "./report.mjs";
import { VERSION } from "./version.mjs";

const USAGE = `assertmedia ${VERSION} - deterministic assertions for media your agent generates

Usage
  assertmedia check <file|dir...> --spec <spec.json> [options]
  assertmedia init <file>                 print a starting spec derived from one file
  assertmedia probe <file>                show what was measured, and what could not be
  assertmedia --version | --help

Options
  --spec=FILE        assertions to apply (required for check)
  --json             machine-readable output on stdout
  --report=FILE      also write a Markdown report
  --strict           a skipped check counts as a failure (no silent green)
  --recursive        recurse into directories
  --quiet            print only the summary and the exit code reason

Exit codes
  0  every requested check passed
  1  a check failed, or --strict and something could not be measured
  2  usage error, unreadable file, or invalid spec

Checks are deterministic and offline. PNG pixels, WAV samples and MP4 boxes are
parsed natively; ffmpeg is only used for extra sampling and every check it could
not perform is reported as "skip", never as a pass.
`;

function fail(message) {
  const error = new Error(message);
  error.usage = true;
  throw error;
}

function parseArgs(argv) {
  const options = { command: null, paths: [], flags: new Set(), values: {} };
  const valueFlags = new Set(["spec", "report"]);
  const booleanFlags = new Set(["json", "strict", "recursive", "quiet", "help", "version"]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      const key = equals === -1 ? body : body.slice(0, equals);
      let value = equals === -1 ? null : body.slice(equals + 1);

      if (valueFlags.has(key)) {
        if (value === null || value === "") {
          const next = argv[index + 1];
          if (next === undefined || next.startsWith("--")) {
            fail(`--${key} needs a value, for example --${key}=file`);
          }
          value = next;
          index += 1;
        }
        options.values[key] = value;
      } else if (booleanFlags.has(key)) {
        if (value) fail(`--${key} does not take a value`);
        options.flags.add(key);
      } else {
        fail(`unknown option --${key}`);
      }
    } else if (!options.command) {
      options.command = arg;
    } else {
      options.paths.push(arg);
    }
  }
  return options;
}

function collectFiles(inputs, { recursive = false } = {}) {
  const extensions = supportedExtensions();
  const files = [];
  for (const input of inputs) {
    let stat;
    try {
      stat = fs.statSync(input);
    } catch (error) {
      fail(`cannot read ${input}: ${error.code === "ENOENT" ? "no such file or directory" : error.message}`);
    }
    if (!stat.isDirectory()) {
      files.push(input);
      continue;
    }
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive) walk(full);
        } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
          files.push(full);
        }
      }
    };
    walk(input);
  }
  if (!files.length) fail("no media files found in the given paths");
  return files;
}

function probeOrFail(file) {
  try {
    return probeFile(file);
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function loadSpec(specPath) {
  let raw;
  try {
    raw = fs.readFileSync(specPath, "utf8");
  } catch (error) {
    fail(`cannot read spec ${specPath}: ${error.message}`);
  }
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (error) {
    fail(`spec ${specPath} is not valid JSON: ${error.message}`);
  }
  try {
    return validateSpec(spec);
  } catch (error) {
    if (error instanceof SpecError) fail(`spec ${specPath}: ${error.message}`);
    throw error;
  }
}

function runCheck(options) {
  const specPath = options.values.spec;
  if (!specPath) fail("check needs --spec=<file>");
  if (!options.paths.length) fail("check needs at least one file or directory");

  const spec = loadSpec(specPath);
  const files = collectFiles(options.paths, { recursive: options.flags.has("recursive") });
  const probes = new Map();
  const results = [];

  for (const file of files) {
    const probe = probeOrFail(file);
    probes.set(file, probe);
    try {
      results.push(evaluate(probe, spec));
    } catch (error) {
      if (error instanceof SpecError) fail(`spec ${specPath}: ${error.message}`);
      throw error;
    }
  }

  const strict = options.flags.has("strict");
  const exitCode = exitCodeFor(results, { strict });
  const groups = ["file", "image", "audio", "video"].filter((group) => spec[group]);

  if (options.flags.has("json")) {
    process.stdout.write(formatJson(results, { specPath, strict, exitCode }) + "\n");
  } else if (options.flags.has("quiet")) {
    const sum = results.reduce(
      (acc, result) => ({
        pass: acc.pass + result.summary.pass,
        fail: acc.fail + result.summary.fail,
        skip: acc.skip + result.summary.skip,
      }),
      { pass: 0, fail: 0, skip: 0 },
    );
    process.stdout.write(`${files.length} files: ${sum.pass} ok, ${sum.fail} failed, ${sum.skip} skipped -> exit ${exitCode}\n`);
    for (const result of results) {
      for (const check of result.checks.filter((item) => item.status === "fail")) {
        process.stdout.write(`FAIL ${result.path} ${check.id}: ${check.actual} (expect ${check.expected})\n`);
      }
    }
  } else {
    process.stdout.write(formatText(results, { specPath, groups, probes, strict }) + "\n");
  }

  if (options.values.report) {
    fs.writeFileSync(options.values.report, formatMarkdown(results, { specPath, strict, exitCode }), "utf8");
    if (!options.flags.has("json")) process.stdout.write(`report written to ${options.values.report}\n`);
  }

  return exitCode;
}

function runInit(options) {
  const file = options.paths[0];
  if (!file) fail("init needs a file");
  const probe = probeOrFail(file);
  let spec;
  try {
    spec = specFromProbe(probe);
  } catch (error) {
    if (error instanceof SpecError) {
      fail(`${error.message}. Probe it with: assertmedia probe ${file}`);
    }
    throw error;
  }
  process.stdout.write(JSON.stringify(spec, null, 2) + "\n");
  process.stderr.write(`# derived from ${file} (${probeSummary(probe)}); tighten these numbers before using them in CI\n`);
  return 0;
}

function runProbe(options) {
  const file = options.paths[0];
  if (!file) fail("probe needs a file");
  const probe = probeOrFail(file);

  if (options.flags.has("json")) {
    process.stdout.write(JSON.stringify(probe, null, 2) + "\n");
    return 0;
  }

  const lines = [`${file}  ${probe.kind}  ${probeSummary(probe)}`];
  lines.push(`  format ${probe.container ?? probe.format}, ${probe.bytes} bytes`);
  if (probe.image?.pixels) {
    const pixels = probe.image.pixels;
    lines.push(`  pixels: ${pixels.quantizedColors} colours (4-bit), ${(pixels.modalRatio * 100).toFixed(1)}% one colour, luma stdDev ${pixels.stdDevLuma}, ${(pixels.transparentRatio * 100).toFixed(1)}% transparent`);
  }
  if (probe.audio) {
    lines.push(`  audio: ${probe.audio.codec ?? "?"} ${probe.audio.sampleRate ?? "?"}Hz ${probe.audio.channels ?? "?"}ch, level ${probe.audio.measured ? "measured" : "not measured"}`);
  }
  if (probe.video?.frames) {
    const blank = probe.video.frames.filter((frame) => frame.blank).length;
    lines.push(`  frames: sampled ${probe.video.frames.length}, blank ${blank} (${probe.video.frames[0].sample})`);
  }
  for (const item of probe.unavailable) lines.push(`  not measured: ${item.id} - ${item.reason}`);
  if (!probe.unavailable.length) lines.push("  not measured: nothing");
  lines.push(`  ffmpeg ${availableTools().ffmpeg ? "available" : "missing"}, ffprobe ${availableTools().ffprobe ? "available" : "missing"}`);

  process.stdout.write(lines.join("\n") + "\n");
  return probe.kind === "unknown" ? 2 : 0;
}

function main(argv) {
  const options = parseArgs(argv);

  if (options.flags.has("help") || !options.command) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.flags.has("version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  switch (options.command) {
    case "check":
      return runCheck(options);
    case "init":
      return runInit(options);
    case "probe":
      return runProbe(options);
    default:
      fail(`unknown command "${options.command}" (expected check, init or probe)`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`assertmedia: ${error.message}\n`);
  if (error.usage) process.stderr.write("run: assertmedia --help\n");
  process.exitCode = 2;
}
