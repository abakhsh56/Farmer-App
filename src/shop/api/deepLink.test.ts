import { describe, expect, it } from 'vitest';
import { normaliseShopCode, parseShopLink } from './deepLink';

describe('parseShopLink', () => {
  it('reads the join link from a shop sticker', () => {
    expect(parseShopLink('agrishop://join?code=AB12CD')).toEqual({ kind: 'join', code: 'AB12CD' });
  });

  it('forgives case, spaces and dashes, because the code is read off a sticker', () => {
    expect(parseShopLink('agrishop://join?code=ab12-cd')).toEqual({ kind: 'join', code: 'AB12CD' });
    expect(parseShopLink('AGRISHOP://JOIN?CODE=AB%2012CD')).toEqual({
      kind: 'join',
      code: 'AB12CD',
    });
  });

  it('reads an invitation, which is the owner sending a token to one farmer', () => {
    const token = 'a'.repeat(64);
    expect(parseShopLink(`agrishop://farmer?token=${token}`)).toEqual({ kind: 'invite', token });
  });

  it('refuses a short code rather than guessing at the rest of it', () => {
    expect(parseShopLink('agrishop://join?code=AB12C')).toBeNull();
    expect(parseShopLink('agrishop://join?code=AB12CDE')).toBeNull();
  });

  it('refuses a token that cannot be one', () => {
    expect(parseShopLink('agrishop://farmer?token=short')).toBeNull();
    expect(parseShopLink(`agrishop://farmer?token=${'a '.repeat(40)}`)).toBeNull();
  });

  it('is not fooled by a link with no query, or no link at all', () => {
    expect(parseShopLink('agrishop://join')).toBeNull();
    expect(parseShopLink('')).toBeNull();
    expect(parseShopLink(null)).toBeNull();
    expect(parseShopLink('hello')).toBeNull();
  });

  it('prefers a code when a link carries both, because a code is not a credential', () => {
    expect(parseShopLink(`agrishop://join?token=${'a'.repeat(64)}&code=AB12CD`)).toEqual({
      kind: 'join',
      code: 'AB12CD',
    });
  });
});

describe('normaliseShopCode', () => {
  it('accepts exactly six characters from the alphabet a shop prints', () => {
    expect(normaliseShopCode('ab-12 cd')).toBe('AB12CD');
    expect(normaliseShopCode('AB12C')).toBeNull();
    expect(normaliseShopCode('AB12C!')).toBeNull();
    expect(normaliseShopCode(null)).toBeNull();
  });
});
