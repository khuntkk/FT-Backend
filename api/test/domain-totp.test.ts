import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { base32Decode, base32Encode, codeAt, matchingStep, newSecret, otpauthUrl, stepAt } from '../src/auth/totp.ts';

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('encodes base32 as the RFC does', () => {
    assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(base32Decode(RFC_SECRET).toString(), '12345678901234567890');
  });

  it('gives the RFC 6238 test values', () => {
    const at = (seconds: number) => codeAt(RFC_SECRET, stepAt(seconds * 1000), 8);
    assert.equal(at(59), '94287082');
    assert.equal(at(1111111109), '07081804');
    assert.equal(at(1111111111), '14050471');
    assert.equal(at(1234567890), '89005924');
    assert.equal(at(2000000000), '69279037');
    assert.equal(at(20000000000), '65353130');
  });

  it('accepts this step and its neighbours, nothing further', () => {
    const now = 1_790_000_000_000;
    const step = stepAt(now);
    assert.equal(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step), now), step);
    assert.equal(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step - 1), now), step - 1);
    assert.equal(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step + 1), now), step + 1);
    assert.equal(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step - 2), now), null);
    assert.equal(matchingStep(RFC_SECRET, '12345', now), null);
  });

  it('makes 160-bit secrets and a scannable URL', () => {
    const s = newSecret();
    assert.match(s, /^[A-Z2-7]{32}$/);
    assert.equal(otpauthUrl(s, 'a@b.co'),
      `otpauth://totp/StitchFlow%3Aa%40b.co?secret=${s}&issuer=StitchFlow&algorithm=SHA1&digits=6&period=30`);
  });
});
