import { describe, expect, it } from 'vitest';
import { catalogs, type MessageKey } from '../i18n/catalog';
import { formatHour } from '../i18n/format';
import { renderAdvisoryCopy, type AdvisoryCopyCtx } from './advisoryCopy';
import type { AdvisoryItem } from './advisory';

/**
 * The words, shaped to the farmer reading them — tested against the real
 * catalogue, so the test reads what the farmer reads.
 *
 * The flagship: the same spray window, at two capability levels. Simple is a
 * short plain sentence; detailed adds the numbers and the reason. The numbers
 * never change between them — only the words around them.
 */

function translate(
  locale: 'en' | 'ur',
  key: MessageKey,
  values?: Record<string, string | number>,
): string {
  const template = catalogs[locale][key] ?? catalogs.en[key] ?? key;
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in values ? String(values[name]) : `{${name}}`,
  );
}

const ctx: AdvisoryCopyCtx = {
  t: (key, values) => translate('en', key, values),
  tUr: (key, values) => translate('ur', key, values),
  formatHour: (hour) => formatHour(hour, (key, values) => translate('en', key, values)),
  formatHourUr: (hour) => formatHour(hour, (key, values) => translate('ur', key, values)),
};

function sprayItem(): AdvisoryItem {
  return {
    kind: 'spray',
    priority: 10,
    source: 'Open-Meteo',
    observedAt: Date.now(),
    spray: {
      state: 'window',
      category: 'weather',
      level: 'info',
      priority: 10,
      windowStartMs: new Date('2026-11-07T12:00:00').getTime(),
      windowEndMs: new Date('2026-11-07T15:00:00').getTime(),
      day: 'today',
      reason: 'calm',
    },
    windowWindKph: 8,
    windowTempC: 25,
    windowHumidityPct: 60,
    windowDeltaT: 6,
  };
}

describe('renderAdvisoryCopy', () => {
  it('simple spray is a short plain sentence, not the numbered version', () => {
    const copy = renderAdvisoryCopy(sprayItem(), 'simple', ctx);
    expect(copy.title).toBe('Spray today, 12 PM to 3 PM');
    expect(copy.body).toBe('The wind is light.');
    expect(copy.title).not.toContain('km/h');
    expect(copy.title).not.toContain('Delta T');
  });

  it('detailed spray adds the numbers and the reason, for the same window', () => {
    const copy = renderAdvisoryCopy(sprayItem(), 'detailed', ctx);
    expect(copy.title).toContain('Wind 8 km/h');
    expect(copy.title).toContain('temperature 25°');
    expect(copy.title).toContain('humidity 60%');
    expect(copy.title).toContain('Delta T 6°');
    expect(copy.title).toContain('12 PM to 3 PM');
  });

  it('standard spray reuses the engine’s two lines', () => {
    const copy = renderAdvisoryCopy(sprayItem(), 'standard', ctx);
    expect(copy.title).toContain('Best time to spray today');
    expect(copy.body).toBe('Wind calm, no rain expected');
  });

  it('the listen text is always Urdu', () => {
    const simple = renderAdvisoryCopy(sprayItem(), 'simple', ctx);
    expect(simple.listenText).toContain('سپرے کرو');
    expect(simple.listenText).toContain('ہوا ہلکی ہے');
    const detailed = renderAdvisoryCopy(sprayItem(), 'detailed', ctx);
    expect(detailed.listenText).toContain('سپرے کرو');
  });

  it('warnings are short at every level', () => {
    const thunder: AdvisoryItem = {
      kind: 'spray',
      priority: 1,
      source: 'Open-Meteo',
      observedAt: Date.now(),
      spray: {
        state: 'do-not-spray',
        category: 'weather',
        level: 'urgent',
        priority: 1,
        windowStartMs: null,
        windowEndMs: null,
        day: null,
        reason: 'thunderstorm',
      },
    };
    for (const level of ['simple', 'standard', 'detailed'] as const) {
      const copy = renderAdvisoryCopy(thunder, level, ctx);
      expect(copy.title).toBe('Do not spray now');
      expect(copy.body).toBe('Thunderstorm nearby, wait until it passes');
    }
  });

  it('an insight-backed item is level-shaped, not reworded', () => {
    const item: AdvisoryItem = {
      kind: 'stage',
      priority: 12,
      source: 'Knowledge base',
      observedAt: Date.now(),
      insightId: 'i1',
      titleKey: 'insight.wheat.title',
      bodyKey: 'insight.wheat.body',
      actionKey: 'insight.wheat.action',
    };
    const simple = renderAdvisoryCopy(item, 'simple', ctx);
    const standard = renderAdvisoryCopy(item, 'standard', ctx);
    const detailed = renderAdvisoryCopy(item, 'detailed', ctx);
    /* Simple shows the action only; standard the body; detailed body + action. */
    expect(simple.body).not.toBe(standard.body);
    expect(detailed.body).toContain(standard.body);
    expect(simple.title).toBe(standard.title);
  });

  it('rain-free warning carries the rain time at every level', () => {
    const item: AdvisoryItem = {
      kind: 'rainfree',
      priority: 6,
      source: 'Open-Meteo',
      observedAt: Date.now(),
      rainAtMs: new Date('2026-11-07T16:00:00').getTime(),
    };
    const simple = renderAdvisoryCopy(item, 'simple', ctx);
    expect(simple.title).toBe('Finish spraying before the rain');
    expect(simple.body).toContain('4 PM');
    const detailed = renderAdvisoryCopy(item, 'detailed', ctx);
    expect(detailed.body).toContain('6 dry hours');
  });

  it('no-crop and no-data keep the plain wording', () => {
    const noCrop = renderAdvisoryCopy(
      { kind: 'noCrop', priority: 20, source: 'Knowledge base', observedAt: Date.now() },
      'simple',
      ctx,
    );
    expect(noCrop.title).toBe('Add your crop to get spray advice');
    const noData = renderAdvisoryCopy(
      { kind: 'noData', priority: 20, source: 'Open-Meteo', observedAt: Date.now() },
      'detailed',
      ctx,
    );
    expect(noData.title).toBe('Spray advice needs an hourly forecast');
  });
});
