/**
 * Call recordings arrive as WAV (uncompressed, ~1–2 MB a minute). Before they are stored they are turned into a
 * mono MP3 at speech quality (24 kbps for 8 kHz phone audio, 32 kbps up to 16 kHz, 48 kbps above): a fifth to a
 * tenth of the size for 16-bit WAV, about a third for 8-bit μ-law / A-law WAV. Anything that is
 * not a plain WAV the encoder understands is stored as it came — a recording is never lost to compression.
 */
import { Mp3Encoder } from '@breezystack/lamejs';

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

interface Wav { rate: number; channels: number; samples: Int16Array }

/** G.711 μ-law / A-law byte → 16-bit sample. */
function ulaw(b: number): number {
  const u = ~b & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
}
function alaw(b: number): number {
  const a = b ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  t = seg === 0 ? t + 8 : seg === 1 ? t + 0x108 : (t + 0x108) << (seg - 1);
  return a & 0x80 ? t : -t;
}

/** A WAV file's sound as mono 16-bit samples (null when it is not a WAV this can read). */
export function readWav(buf: Buffer): Wav | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  for (let p = 12; p + 8 <= buf.length; ) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe && size >= 26 && body + 26 <= buf.length) format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
      break;
    }
    p = body + size + (size % 2);
  }
  if (!fmt || !data || fmt.channels < 1 || fmt.channels > 2) return null;
  const { format, channels, rate, bits } = fmt;
  const width = format === 6 || format === 7 ? 1 : bits / 8;
  if (![1, 2, 3, 4].includes(width)) return null;
  const frames = Math.floor(data.length / (width * channels));
  const out = new Int16Array(frames);
  const sample = (i: number): number => {
    if (format === 7) return ulaw(data![i]);
    if (format === 6) return alaw(data![i]);
    if (format === 3 && bits === 32) return Math.max(-32768, Math.min(32767, Math.round(data!.readFloatLE(i) * 32767)));
    if (format !== 1) return NaN;
    if (width === 1) return (data![i] - 128) << 8;
    if (width === 2) return data!.readInt16LE(i);
    if (width === 3) return data!.readIntLE(i, 3) >> 8;
    return data!.readInt32LE(i) >> 16;
  };
  for (let f = 0; f < frames; f++) {
    let v = 0;
    for (let ch = 0; ch < channels; ch++) v += sample((f * channels + ch) * width);
    v /= channels;
    if (Number.isNaN(v)) return null;
    out[f] = v;
  }
  return { rate, channels, samples: out };
}

/** Mono 16-bit samples → MP3 bytes. */
function encodeMp3(w: Wav): Buffer {
  // phone audio (8 kHz) needs little; wider-band recordings get a bit more so voices stay clear
  const enc = new Mp3Encoder(1, w.rate, w.rate <= 8000 ? 24 : w.rate <= 16000 ? 32 : 48);
  const parts: Uint8Array[] = [];
  const BLOCK = 1152;
  for (let i = 0; i < w.samples.length; i += BLOCK) {
    const chunk = enc.encodeBuffer(w.samples.subarray(i, i + BLOCK));
    if (chunk.length) parts.push(chunk);
  }
  const end = enc.flush();
  if (end.length) parts.push(end);
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}

/**
 * A recording ready to store: WAV becomes MP3 (name and type follow); anything else, an unusual WAV, or an MP3 that
 * would not be smaller, is returned unchanged.
 */
export function compactRecording(data: Buffer, mime: string, name: string): { data: Buffer; mime: string; name: string; compressed: boolean } {
  const same = { data, mime, name, compressed: false };
  try {
    const w = readWav(data);
    if (!w || !MP3_RATES.includes(w.rate) || !w.samples.length) return same;
    const mp3 = encodeMp3(w);
    if (!mp3.length || mp3.length >= data.length) return same;
    return { data: mp3, mime: 'audio/mpeg', name: name.replace(/\.(wav|wave)$/i, '') + '.mp3', compressed: true };
  } catch {
    return same;
  }
}
