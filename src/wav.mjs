const round = (value, digits) => Number(value.toFixed(digits));

const FORMAT_INTEGER_PCM = 1;
const FORMAT_FLOAT_PCM = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function toFloat(sample, bitsPerSample, format) {
  if (format === FORMAT_FLOAT_PCM) return bitsPerSample === 64 ? sample : sample;
  switch (bitsPerSample) {
    case 8:
      return (sample - 128) / 128;
    case 16:
      return sample / 32768;
    case 24:
      return sample / 8388608;
    case 32:
      return sample / 2147483648;
    default:
      return 0;
  }
}

function readSample(buf, offset, bitsPerSample, format) {
  if (format === FORMAT_FLOAT_PCM) {
    return bitsPerSample === 64 ? buf.readDoubleLE(offset) : buf.readFloatLE(offset);
  }
  switch (bitsPerSample) {
    case 8:
      return buf[offset];
    case 16:
      return buf.readInt16LE(offset);
    case 24:
      return buf.readIntLE(offset, 3);
    case 32:
      return buf.readInt32LE(offset);
    default:
      return 0;
  }
}

/**
 * Parse a RIFF/WAVE file and measure level. Only uncompressed PCM (int or
 * float) is measured; compressed codecs return ok:false with a reason so the
 * caller can fall back to ffprobe or report SKIP.
 */
export function decodeWav(buf) {
  if (buf.length < 12) return { ok: false, reason: "file too small to be a WAV" };
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") {
    return { ok: false, reason: "not a RIFF/WAVE file" };
  }

  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("latin1", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(start);
      const channels = buf.readUInt16LE(start + 2);
      const sampleRate = buf.readUInt32LE(start + 4);
      const byteRate = buf.readUInt32LE(start + 8);
      const bitsPerSample = buf.readUInt16LE(start + 14);
      if (format === FORMAT_EXTENSIBLE && size >= 26) {
        // The first two bytes of the SubFormat GUID mirror the format tag.
        format = buf.readUInt16LE(start + 24);
      }
      fmt = { format, channels, sampleRate, byteRate, bitsPerSample };
    } else if (id === "data") {
      data = buf.subarray(start, Math.min(start + size, buf.length));
    }
    offset = start + size + (size % 2);
  }

  if (!fmt) return { ok: false, reason: "WAV has no fmt chunk" };
  if (!data) return { ok: false, reason: "WAV has no data chunk" };
  if (fmt.format !== FORMAT_INTEGER_PCM && fmt.format !== FORMAT_FLOAT_PCM) {
    return { ok: false, reason: `compressed WAV (format ${fmt.format}) is not measured` };
  }
  if (![8, 16, 24, 32].includes(fmt.bitsPerSample) && !(fmt.format === FORMAT_FLOAT_PCM && fmt.bitsPerSample === 64)) {
    return { ok: false, reason: `${fmt.bitsPerSample}-bit samples are not supported` };
  }

  const blockAlign = (fmt.bitsPerSample / 8) * fmt.channels;
  if (!blockAlign) return { ok: false, reason: "invalid block alignment" };
  const frames = Math.floor(data.length / blockAlign);
  if (!frames) return { ok: false, reason: "no audio frames in data chunk" };

  let peak = 0;
  let sumSquares = 0;
  const samplesPerWindow = Math.max(1, Math.round(fmt.sampleRate / 10)); // 100 ms
  let windowSquares = 0;
  let windowCount = 0;
  let silentWindows = 0;
  let windowTotal = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < fmt.channels; channel += 1) {
      const raw = readSample(data, frame * blockAlign + channel * (fmt.bitsPerSample / 8), fmt.bitsPerSample, fmt.format);
      const value = toFloat(raw, fmt.bitsPerSample, fmt.format);
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
      sumSquares += value * value;
      windowSquares += value * value;
      windowCount += 1;
    }
    if (windowCount >= samplesPerWindow * fmt.channels || frame === frames - 1) {
      const windowRms = Math.sqrt(windowSquares / Math.max(1, windowCount));
      const windowDb = windowRms > 0 ? 20 * Math.log10(windowRms) : -Infinity;
      if (windowDb < -50) silentWindows += 1;
      windowTotal += 1;
      windowSquares = 0;
      windowCount = 0;
    }
  }

  const rms = Math.sqrt(sumSquares / (frames * fmt.channels));
  const duration = data.length / (fmt.byteRate || fmt.sampleRate * blockAlign || 1);

  return {
    ok: true,
    codec: "pcm",
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    duration: round(duration, 3),
    peakDbfs: peak > 0 ? round(20 * Math.log10(peak), 2) : -Infinity,
    rmsDbfs: rms > 0 ? round(20 * Math.log10(rms), 2) : -Infinity,
    silentWindows,
    windows: windowTotal,
    silenceRatio: windowTotal ? round(silentWindows / windowTotal, 4) : 0,
  };
}
