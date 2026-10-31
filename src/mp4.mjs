const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta"]);

const VIDEO_CODECS = {
  avc1: "h264",
  avc3: "h264",
  hev1: "hevc",
  hvc1: "hevc",
  av01: "av1",
  vp09: "vp9",
  mp4v: "mpeg4",
  ap4h: "prores",
  apcn: "prores",
};

const AUDIO_CODECS = {
  mp4a: "aac",
  Opus: "opus",
  opus: "opus",
  alac: "alac",
  "ac-3": "ac3",
  "ec-3": "eac3",
  fLaC: "flac",
  ".mp3": "mp3",
};

const round = (value, digits) => Number(value.toFixed(digits));

function boxes(buf, start, end, depth = 0) {
  const out = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buf.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    const box = { type, start: offset + header, end: offset + size };
    if (CONTAINERS.has(type) && depth < 8) {
      box.children = boxes(buf, box.start, box.end, depth + 1);
    }
    out.push(box);
    offset += size;
  }
  return out;
}

const child = (list, type) => (list ?? []).find((box) => box.type === type);

function readMvhd(buf, box) {
  const version = buf[box.start];
  if (version === 1) {
    return {
      timescale: buf.readUInt32BE(box.start + 20),
      duration: Number(buf.readBigUInt64BE(box.start + 24)),
    };
  }
  return {
    timescale: buf.readUInt32BE(box.start + 12),
    duration: buf.readUInt32BE(box.start + 16),
  };
}

function readTkhd(buf, box) {
  const version = buf[box.start];
  const base = version === 1 ? box.start + 88 : box.start + 76;
  if (base + 8 > box.end) return { width: null, height: null };
  return {
    width: round(buf.readUInt32BE(base) / 65536, 2),
    height: round(buf.readUInt32BE(base + 4) / 65536, 2),
  };
}

function readMdhd(buf, box) {
  const version = buf[box.start];
  if (version === 1) {
    return {
      timescale: buf.readUInt32BE(box.start + 20),
      duration: Number(buf.readBigUInt64BE(box.start + 24)),
    };
  }
  return {
    timescale: buf.readUInt32BE(box.start + 12),
    duration: buf.readUInt32BE(box.start + 16),
  };
}

function readHandler(buf, box) {
  if (box.start + 12 > box.end) return null;
  return buf.toString("latin1", box.start + 8, box.start + 12);
}

function readSampleEntry(buf, stsd) {
  if (!stsd || stsd.start + 16 > stsd.end) return null;
  const entryStart = stsd.start + 8;
  const entrySize = buf.readUInt32BE(entryStart);
  const format = buf.toString("latin1", entryStart + 4, entryStart + 8);
  const entry = { format, entryStart, entryEnd: Math.min(entryStart + entrySize, stsd.end) };

  if (VIDEO_CODECS[format]) {
    if (entryStart + 36 <= entry.entryEnd) {
      entry.width = buf.readUInt16BE(entryStart + 32);
      entry.height = buf.readUInt16BE(entryStart + 34);
    }
  } else if (AUDIO_CODECS[format]) {
    if (entryStart + 28 <= entry.entryEnd) {
      entry.channels = buf.readUInt16BE(entryStart + 24);
      entry.bitsPerSample = buf.readUInt16BE(entryStart + 26);
    }
    if (entryStart + 36 <= entry.entryEnd) {
      entry.sampleRate = buf.readUInt32BE(entryStart + 32) / 65536;
    }
  }
  return entry;
}

/**
 * Parse an ISO base media file (MP4/MOV/M4A) without decoding frames.
 * Gives duration, dimensions, codec and whether an audio track exists.
 */
export function decodeMp4(buf) {
  if (buf.length < 8) return { ok: false, reason: "file too small to be an MP4" };

  const top = boxes(buf, 0, buf.length);
  const moov = child(top, "moov");
  if (!moov) {
    const ftyp = child(top, "ftyp");
    if (!ftyp) return { ok: false, reason: "no moov box (not an MP4/MOV, or fragmented without init segment)" };
    return { ok: false, reason: "moov box missing (fragmented MP4 without init segment?)" };
  }

  const mvhd = child(moov.children, "mvhd");
  const header = mvhd ? readMvhd(buf, mvhd) : null;
  let duration = header && header.timescale ? header.duration / header.timescale : null;

  const tracks = [];
  for (const trak of (moov.children ?? []).filter((box) => box.type === "trak")) {
    const tkhd = child(trak.children, "tkhd");
    const mdia = child(trak.children, "mdia");
    const mdhd = mdia ? child(mdia.children, "mdhd") : null;
    const hdlr = mdia ? child(mdia.children, "hdlr") : null;
    const stsd =
      mdia && child(mdia.children, "minf")
        ? child(child(mdia.children, "minf").children, "stbl")
          ? child(child(child(mdia.children, "minf").children, "stbl").children, "stsd")
          : null
        : null;

    const timing = mdhd ? readMdhd(buf, mdhd) : null;
    const trackDuration = timing && timing.timescale ? timing.duration / timing.timescale : null;
    if (trackDuration && (!duration || trackDuration > duration)) duration = trackDuration;

    const entry = readSampleEntry(buf, stsd);
    tracks.push({
      handler: hdlr ? readHandler(buf, hdlr) : null,
      frame: tkhd ? readTkhd(buf, tkhd) : { width: null, height: null },
      codec: entry ? entry.format : null,
      entry,
      duration: trackDuration,
    });
  }

  const video = tracks.find((track) => track.handler === "vide");
  const audio = tracks.find((track) => track.handler === "soun");
  if (!video && !audio) return { ok: false, reason: "no audio or video track found" };

  const codecOf = (track) => (track?.codec ? VIDEO_CODECS[track.codec] ?? AUDIO_CODECS[track.codec] ?? track.codec : null);

  if (!video) {
    return {
      ok: true,
      container: "mp4",
      kind: "audio",
      codec: codecOf(audio),
      channels: audio.entry?.channels ?? null,
      sampleRate: audio.entry?.sampleRate ? round(audio.entry.sampleRate, 0) : null,
      duration: duration ? round(duration, 3) : null,
    };
  }

  return {
    ok: true,
    container: "mp4",
    kind: "video",
    codec: codecOf(video),
    width: video.entry?.width || video.frame.width || null,
    height: video.entry?.height || video.frame.height || null,
    duration: duration ? round(duration, 3) : null,
    hasAudio: Boolean(audio),
    audio: audio
      ? {
          codec: codecOf(audio),
          channels: audio.entry?.channels ?? null,
          sampleRate: audio.entry?.sampleRate ? round(audio.entry.sampleRate, 0) : null,
        }
      : null,
    tracks: tracks.map((track) => ({ handler: track.handler, codec: codecOf(track) })),
  };
}
