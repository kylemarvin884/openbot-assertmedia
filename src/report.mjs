import { probeSummary } from "./probe.mjs";
import { VERSION } from "./version.mjs";

const STATUS_LABEL = { pass: "ok", fail: "FAIL", skip: "skip" };

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function totals(results) {
  return results.reduce(
    (acc, result) => ({
      files: acc.files + 1,
      pass: acc.pass + result.summary.pass,
      fail: acc.fail + result.summary.fail,
      skip: acc.skip + result.summary.skip,
    }),
    { files: 0, pass: 0, fail: 0, skip: 0 },
  );
}

export function formatText(results, { specPath, groups = [], probes = new Map(), strict = false } = {}) {
  const lines = [];
  lines.push(`assertmedia ${VERSION}  spec ${specPath}${groups.length ? `  [${groups.join(", ")}]` : ""}`);
  lines.push("");

  for (const result of results) {
    const probe = probes.get(result.path);
    lines.push(`${result.path}  ${probe ? probeSummary(probe) : result.kind}`);
    const width = Math.max(...result.checks.map((check) => check.id.length), 10) + 2;
    for (const check of result.checks) {
      const status = STATUS_LABEL[check.status] ?? check.status;
      if (check.status === "skip") {
        lines.push(`  ${pad(status, 5)} ${pad(check.id, width)}${check.reason ?? "not measured"}`);
      } else {
        lines.push(`  ${pad(status, 5)} ${pad(check.id, width)}${check.actual}   (expect ${check.expected})`);
      }
    }
    lines.push("");
  }

  const sum = totals(results);
  const verdict = sum.fail > 0 ? "exit 1" : strict && sum.skip > 0 ? "exit 1 (strict: skips fail)" : "exit 0";
  lines.push(`${sum.files} file${sum.files === 1 ? "" : "s"}: ${sum.pass} ok, ${sum.fail} failed, ${sum.skip} skipped -> ${verdict}`);
  if (sum.skip > 0 && !strict) lines.push("skipped checks were not verified; pass --strict to turn them into failures");
  return lines.join("\n");
}

export function formatJson(results, { specPath, strict = false, exitCode = 0 } = {}) {
  const sum = totals(results);
  return JSON.stringify(
    {
      tool: "assertmedia",
      version: VERSION,
      spec: specPath,
      strict,
      exitCode,
      summary: sum,
      results,
    },
    null,
    2,
  );
}

export function formatMarkdown(results, { specPath, exitCode = 0, strict = false } = {}) {
  const sum = totals(results);
  const lines = [
    "# assertmedia report",
    "",
    `- spec: \`${specPath}\``,
    `- strict: ${strict ? "yes" : "no"}`,
    `- result: ${sum.pass} ok, ${sum.fail} failed, ${sum.skip} skipped (exit ${exitCode})`,
    "",
    "| file | check | result | actual | expected |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    for (const check of result.checks) {
      const actual = check.status === "skip" ? check.reason ?? "not measured" : check.actual;
      const expected = check.status === "skip" ? "not verified" : check.expected;
      lines.push(`| \`${result.path}\` | \`${check.id}\` | ${STATUS_LABEL[check.status]} | ${actual} | ${expected} |`);
    }
  }
  return lines.join("\n") + "\n";
}
