import assert from "node:assert/strict";
import test from "node:test";

import { decodePng, encodePng } from "../src/png.mjs";
import { blankVerdict, imageStats } from "../src/stats.mjs";
import { gradientPng, palettePng, solidPng, transparentPng } from "../src/fixtures.mjs";

test("PNG round-trip preserves pixels", () => {
  const width = 7;
  const height = 5;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = i * 3;
    rgba[i * 4 + 1] = 255 - i;
    rgba[i * 4 + 2] = i * 7;
    rgba[i * 4 + 3] = 255;
  }
  const decoded = decodePng(encodePng({ width, height, rgba }));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(Buffer.from(decoded.rgba), rgba);
});

test("solid image decodes to a single colour", () => {
  const decoded = decodePng(solidPng({ width: 40, height: 30, color: [255, 255, 255, 255] }));
  const stats = imageStats(decoded.rgba, decoded.width, decoded.height);
  assert.equal(stats.quantizedColors, 1);
  assert.equal(stats.stdDevLuma, 0);
  assert.equal(stats.modalRatio, 1);
  assert.equal(blankVerdict(stats).blank, true, "a flat white image must be reported as blank");
});

test("gradient image is not blank", () => {
  const decoded = decodePng(gradientPng({ width: 120, height: 80 }));
  const stats = imageStats(decoded.rgba, decoded.width, decoded.height);
  assert.ok(stats.stdDevLuma > 5, `expected variation, got stdDev ${stats.stdDevLuma}`);
  assert.ok(stats.quantizedColors > 20);
  assert.equal(blankVerdict(stats).blank, false);
});

test("fully transparent image is blank", () => {
  const decoded = decodePng(transparentPng({ width: 30, height: 30 }));
  const stats = imageStats(decoded.rgba, decoded.width, decoded.height);
  assert.equal(stats.transparentRatio, 1);
  assert.equal(blankVerdict(stats).blank, true);
});

test("palette PNG decodes through PLTE", () => {
  const decoded = decodePng(palettePng({ width: 32, height: 8 }));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.colorType, 3);
  const stats = imageStats(decoded.rgba, decoded.width, decoded.height);
  assert.equal(stats.quantizedColors, 4);
});

test("a file that is not a PNG is rejected with a reason", () => {
  const decoded = decodePng(Buffer.from("definitely not a png", "latin1"));
  assert.equal(decoded.ok, false);
  assert.match(decoded.reason, /not a PNG/);
});

test("truncated image data is rejected instead of half-decoded", () => {
  const png = encodePng({ width: 16, height: 16, rgba: Buffer.alloc(16 * 16 * 4, 200) });
  const decoded = decodePng(png.subarray(0, png.length - 30));
  assert.equal(decoded.ok, false);
});
