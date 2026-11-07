import { describe, expect, it } from 'vitest';

import { pickVoice } from './speech';

/**
 * The voice the app reads with: Saraiki first, Urdu after.
 *
 * The farmer's own preference is a native Saraiki speaker, so a Saraiki voice
 * wins over an Urdu one even when the words being read are Urdu — the app has
 * no Saraiki advice text yet, only navigation, so the voice is Saraiki and the
 * words stay Urdu. Without a Saraiki voice the Urdu matches run in their old
 * order, and without either the answer is `undefined`, never an English voice.
 * Bare `sk` is deliberately not Saraiki here: it is Slovak's code.
 */

function voice(lang: string, name: string): SpeechSynthesisVoice {
  return { lang, name } as SpeechSynthesisVoice;
}

describe('pickVoice prefers a Saraiki voice', () => {
  it('takes an exact skr-PK voice over an Urdu one', () => {
    const saraiki = voice('skr-PK', 'Saraiki');
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([urdu, saraiki], 'ur-PK')).toBe(saraiki);
  });

  it('takes a skr voice over an Urdu one', () => {
    const saraiki = voice('skr', 'Saraiki');
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([urdu, saraiki], 'ur-PK')).toBe(saraiki);
  });

  it('takes the app Saraiki tag sk-PK over an Urdu one', () => {
    const saraiki = voice('sk-PK', 'Saraiki');
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([urdu, saraiki], 'ur-PK')).toBe(saraiki);
  });

  it('takes a voice named Saraiki even when its tag is unhelpful', () => {
    const saraiki = voice('und', 'Google Saraiki');
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([urdu, saraiki], 'ur-PK')).toBe(saraiki);
  });

  it('prefers an exact Saraiki tag over a looser one', () => {
    const exact = voice('skr-PK', 'Saraiki Pakistan');
    const loose = voice('skr', 'Saraiki');
    expect(pickVoice([loose, exact], 'ur-PK')).toBe(exact);
  });

  it('does not treat a Slovak sk-SK voice as Saraiki', () => {
    const slovak = voice('sk-SK', 'Slovak');
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([slovak, urdu], 'ur-PK')).toBe(urdu);
    expect(pickVoice([slovak], 'ur-PK')).toBeUndefined();
  });
});

describe('pickVoice falls back to Urdu without a Saraiki voice', () => {
  it('takes an exact ur-PK voice', () => {
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([urdu], 'ur-PK')).toBe(urdu);
  });

  it('takes any ur voice when there is no exact tag', () => {
    const urdu = voice('ur-IN', 'Urdu (India)');
    expect(pickVoice([urdu], 'ur-PK')).toBe(urdu);
  });

  it('takes a voice named Urdu when its tag is unhelpful', () => {
    const urdu = voice('und', 'Google Urdu');
    expect(pickVoice([urdu], 'ur-PK')).toBe(urdu);
  });

  it('returns undefined rather than an English voice', () => {
    const english = voice('en-US', 'English (United States)');
    expect(pickVoice([english], 'ur-PK')).toBeUndefined();
    expect(pickVoice([], 'ur-PK')).toBeUndefined();
  });
});
