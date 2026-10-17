import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totpCode, verifyTotp } from '../server/core/totp';

// RFC 6238 Appendix B (SHA-1 seed "12345678901234567890"), last 6 digits of the 8-digit values
const SEED = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(totpCode(SEED, 59 * 1000, 0, 8)).toBe('94287082');
    expect(totpCode(SEED, 1111111109 * 1000, 0, 8)).toBe('07081804');
    expect(totpCode(SEED, 1234567890 * 1000, 0, 8)).toBe('89005924');
    expect(totpCode(SEED, 2000000000 * 1000, 0, 8)).toBe('69279037');
    expect(totpCode(SEED, 59 * 1000)).toBe('287082');
  });

  it('base32 round-trips', () => {
    const b = Buffer.from([0, 1, 2, 250, 255, 128, 64]);
    expect(base32Decode(base32Encode(b))).toEqual(b);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepts the current code and one window either side, nothing else', () => {
    const s = generateTotpSecret();
    const now = Date.UTC(2026, 9, 17, 12, 0, 15);
    expect(verifyTotp(s, totpCode(s, now), now)).toBe(true);
    expect(verifyTotp(s, totpCode(s, now - 30000), now)).toBe(true);
    expect(verifyTotp(s, totpCode(s, now + 30000), now)).toBe(true);
    expect(verifyTotp(s, totpCode(s, now - 90000), now)).toBe(false);
    expect(verifyTotp(s, '12345', now)).toBe(false);
    expect(verifyTotp(s, 'abcdef', now)).toBe(false);
    expect(verifyTotp(s, totpCode(s, now).replace(/(\d{3})/, '$1 '), now)).toBe(true); // "123 456"
  });

  it('builds an otpauth link', () => {
    expect(otpauthUri('Broaddcast CRM', 'a@b.com', 'ABC')).toBe('otpauth://totp/Broaddcast%20CRM%3Aa%40b.com?secret=ABC&issuer=Broaddcast%20CRM&algorithm=SHA1&digits=6&period=30');
  });
});
