const round = (value, digits) => Number(value.toFixed(digits));

/**
 * Quantised colour counting: 4 bits per channel (4096 buckets). It is not a
 * perceptual metric, it only answers "does this image contain variation".
 */
export function imageStats(rgba, width, height) {
  const total = width * height;
  if (!total) return null;

  const counts = new Uint32Array(4096);
  let sum = 0;
  let sumSquares = 0;
  let transparent = 0;

  for (let i = 0; i < total; i += 1) {
    const offset = i * 4;
    const r = rgba[offset];
    const g = rgba[offset + 1];
    const b = rgba[offset + 2];
    const a = rgba[offset + 3];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    sumSquares += luma * luma;
    counts[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)] += 1;
    if (a < 8) transparent += 1;
  }

  const mean = sum / total;
  const variance = Math.max(0, sumSquares / total - mean * mean);

  let modal = 0;
  let colors = 0;
  for (const count of counts) {
    if (count > 0) colors += 1;
    if (count > modal) modal = count;
  }

  return {
    pixels: total,
    meanLuma: round(mean, 2),
    stdDevLuma: round(Math.sqrt(variance), 3),
    quantizedColors: colors,
    modalRatio: round(modal / total, 4),
    transparentRatio: round(transparent / total, 4),
  };
}

/**
 * A "blank" artifact is one a human would call empty: near-zero variance,
 * a single colour covering virtually every pixel, or an almost fully
 * transparent canvas. Thresholds are printed in the report so a false
 * positive can be diagnosed instead of argued about.
 */
export function blankVerdict(stats, { modalThreshold = 0.999, stdDevThreshold = 1.5 } = {}) {
  const flat = stats.stdDevLuma < stdDevThreshold;
  const single = stats.modalRatio >= modalThreshold;
  const transparent = stats.transparentRatio >= 0.99;
  return {
    blank: flat || single || transparent,
    reasons: [
      ...(flat ? [`luma stdDev ${stats.stdDevLuma} < ${stdDevThreshold}`] : []),
      ...(single ? [`one colour covers ${(stats.modalRatio * 100).toFixed(1)}% of pixels`] : []),
      ...(transparent ? [`${(stats.transparentRatio * 100).toFixed(1)}% of pixels are transparent`] : []),
    ],
    thresholds: { modalThreshold, stdDevThreshold },
  };
}
