/** Call recordings: WAV is stored as MP3; anything the encoder cannot read is stored unchanged. */
import { describe, expect, it } from 'vitest';
import { compactRecording, readWav } from '../server/modules/audioCompress';

/** A WAV of `seconds` of a voice-like tone (format 1 = PCM, 6 = A-law, 7 = μ-law). */
function wav(seconds: number, rate: number, channels = 1, bits = 16, format = 1): Buffer {
  const width = format === 1 ? bits / 8 : 1;
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * width);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 9000 + Math.sin((2 * Math.PI * 690 * i) / rate) * 4000);
    for (let ch = 0; ch < channels; ch++) {
      const o = (i * channels + ch) * width;
      if (format !== 1) data[o] = (v >> 8) & 0xff; // not a real G.711 encoding; only needs to decode
      else if (width === 2) data.writeInt16LE(v, o);
      else data[o] = (v >> 8) + 128;
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(format, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * width, 28); h.writeUInt16LE(channels * width, 32); h.writeUInt16LE(format === 1 ? bits : 8, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const isMp3 = (b: Buffer) => b[0] === 0xff && (b[1] & 0xe0) === 0xe0;

describe('call recording compression', () => {
  it('8 kHz phone WAV (16-bit) becomes an MP3 about a fifth of the size, named .mp3', () => {
    const src = wav(60, 8000);
    const out = compactRecording(src, 'audio/wav', 'CALL-0001_recording.wav');
    expect(out).toMatchObject({ compressed: true, mime: 'audio/mpeg', name: 'CALL-0001_recording.mp3' });
    expect(isMp3(out.data)).toBe(true);
    expect(out.data.length).toBeLessThan(src.length / 4);
    expect(out.data.length).toBeGreaterThan(100_000); // ~60 s at 24 kbps is ~180 KB: the whole call is there
  });

  it('16 kHz and 44.1 kHz stereo WAV shrink even more; μ-law WAV is read too', () => {
    const wide = wav(30, 16000);
    expect(compactRecording(wide, 'audio/wav', 'a.wav').data.length).toBeLessThan(wide.length / 6);
    const stereo = wav(20, 44100, 2);
    const s = compactRecording(stereo, 'audio/wav', 'b.wav');
    expect(s.compressed).toBe(true);
    expect(s.data.length).toBeLessThan(stereo.length / 20);
    const mu = wav(30, 8000, 1, 8, 7);
    expect(readWav(mu)!.samples.length).toBe(240_000);
    expect(compactRecording(mu, 'audio/wav', 'c.wav')).toMatchObject({ compressed: true, mime: 'audio/mpeg' });
  });

  it('anything else is stored as it came: not a WAV, a broken WAV, an unsupported rate', () => {
    const webm = Buffer.from('1a45dfa3' + '00'.repeat(200), 'hex');
    expect(compactRecording(webm, 'audio/webm', 'x.webm')).toEqual({ data: webm, mime: 'audio/webm', name: 'x.webm', compressed: false });
    const broken = wav(1, 8000).subarray(0, 30);
    expect(compactRecording(broken, 'audio/wav', 'y.wav').compressed).toBe(false);
    const odd = wav(1, 7000);
    expect(compactRecording(odd, 'audio/wav', 'z.wav')).toMatchObject({ compressed: false, mime: 'audio/wav', name: 'z.wav' });
  });
});
