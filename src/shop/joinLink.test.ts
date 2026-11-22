import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, codeFrom, formatJoinCode, joinCodeFromUrl, joinLink, parseJoinCode } from './joinLink';

describe('shop join codes', () => {
  it('accepts a bare code in any case and with the printed separator', () => {
    expect(parseJoinCode('ABCD349K')).toBe('ABCD349K');
    expect(parseJoinCode('abcd-349k')).toBe('ABCD349K');
    expect(parseJoinCode('  abcd 349k ')).toBe('ABCD349K');
  });

  it('reads the code out of a scanned link, whatever else the link carries', () => {
    expect(parseJoinCode('https://farmer.example/?join=ABCD349K&utm=x')).toBe('ABCD349K');
    expect(parseJoinCode('farmer.example/?join=ABCD349K')).toBe('ABCD349K');
    expect(parseJoinCode('https://farmer.example/join#join=ABCD349K')).toBe('ABCD349K');
  });

  it('refuses a code that is short, long, or outside the alphabet', () => {
    /* A partial code would join the wrong shop, which is worse than a retry. */
    expect(parseJoinCode('ABCD349')).toBeNull();
    expect(parseJoinCode('ABCD349KX')).toBeNull();
    expect(parseJoinCode('')).toBeNull();
    expect(parseJoinCode(null)).toBeNull();
  });

  it('refuses every character the alphabet leaves out on purpose', () => {
    /*
     * These are the ones a person misreads: zero against O, one against I and L,
     * five against S, two against Z. A code containing any of them cannot have
     * been issued by this app, so it is a typo rather than a shop.
     */
    for (const ambiguous of ['0', 'O', '1', 'I', 'L', '5', 'S', '2', 'Z']) {
      expect(parseJoinCode(`ABCD349${ambiguous}`)).toBeNull();
      expect(CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('prints the code in the form a shop owner reads out loud', () => {
    expect(formatJoinCode('abcd349k')).toBe('ABCD-349K');
  });

  it('round-trips through the link the QR carries', () => {
    const link = joinLink('abcd-349k', 'https://farmer.example/');
    expect(link).toBe('https://farmer.example/?join=ABCD349K');
    expect(joinCodeFromUrl(link)).toBe('ABCD349K');
  });

  it('has no code when the launch URL has none', () => {
    expect(joinCodeFromUrl('https://farmer.example/')).toBeNull();
    expect(joinCodeFromUrl('not a url')).toBeNull();
  });

  it('draws only from the alphabet, every time', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = codeFrom(() => index / 200);
      expect(code).toHaveLength(8);
      for (const character of code) expect(CODE_ALPHABET).toContain(character);
    }
  });
});
