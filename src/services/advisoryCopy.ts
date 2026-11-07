/**
 * The words on the card, shaped to the farmer reading them.
 *
 * The advice is the same for two farmers at the same place; the words are
 * not. A low-literacy, voice-first farmer gets a short plain sentence — one
 * action, everyday words, always with a listen option. A farmer who reads
 * long text and writes detailed questions gets the numbers and the reason.
 * The numbers never change between levels — only the words around them — so
 * a short line and a detailed line can never disagree about the morning.
 *
 * · `simple` — very short sentences, plain everyday words, one action per
 *   line. Example: "Aaj spray karo, subah 6-9. Hawa halki hai." — never
 *   "Best time to spray: 6 to 9 AM, wind 8 km/h, Delta T optimal."
 * · `standard` — the existing wording. For spray, the two lines the
 *   spray engine already prints.
 * · `detailed` — the numbers and the reason, for a farmer who asks for them.
 *
 * Warnings are short at every level: a do-not-spray is not the place for
 * detail. Insight-backed items (stage, fertilizer, crop-specific stress)
 * are level-shaped, not reworded — the knowledge base wrote them, so
 * `simple` shows the action only, `standard` the body, `detailed` the body
 * plus the action. The listen text is always Urdu: the farmer pressed a
 * speaker to *hear* the advice.
 */

import type { MessageKey } from '../i18n/catalog';
import type { CapabilityLevel } from './capability';
import type { AdvisoryItem } from './advisory';
import { DRY_SPELL_DAYS, HARVEST_DRY_DAYS, RAINFAST_HOURS } from './advisory';
import { sprayAdviceLines, type SprayAdvice } from './spray';

export type AdvisoryCopy = {
  title: string;
  body: string;
  /** Always Urdu — what the Listen pill reads aloud. */
  listenText: string;
};

export type AdvisoryCopyCtx = {
  /** Translate in the screen's language. */
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  /** Translate in Urdu, for the listen text. */
  tUr: (key: MessageKey, values?: Record<string, string | number>) => string;
  /** An hour of the day, in the screen's language. */
  formatHour: (hour: number) => string;
  /** An hour of the day, in Urdu. */
  formatHourUr: (hour: number) => string;
};

function sprayWindowHours(spray: SprayAdvice): { start: number | null; end: number | null } {
  return {
    start: spray.windowStartMs !== null ? new Date(spray.windowStartMs).getHours() : null,
    end: spray.windowEndMs !== null ? new Date(spray.windowEndMs).getHours() : null,
  };
}

function sprayCopy(
  item: AdvisoryItem,
  level: CapabilityLevel,
  ctx: AdvisoryCopyCtx,
): AdvisoryCopy {
  const spray = item.spray as SprayAdvice;
  const { start, end } = sprayWindowHours(spray);
  const day = spray.day === 'tomorrow' ? ctx.t('weather.spray.tomorrow') : ctx.t('weather.spray.today');
  const dayUr =
    spray.day === 'tomorrow' ? ctx.tUr('weather.spray.tomorrow') : ctx.tUr('weather.spray.today');
  const startLabel = start !== null ? ctx.formatHour(start) : '';
  const endLabel = end !== null ? ctx.formatHour(end) : '';
  const startLabelUr = start !== null ? ctx.formatHourUr(start) : '';
  const endLabelUr = end !== null ? ctx.formatHourUr(end) : '';

  /* Warnings are short at every level — a do-not-spray is not the place
     for detail, and a missing window is one sentence, not a paragraph. */
  if (spray.state === 'do-not-spray' || spray.state === 'no-window') {
    const lines = sprayAdviceLines(ctx.t, spray, startLabel, endLabel);
    const linesUr = sprayAdviceLines(ctx.tUr, spray, startLabelUr, endLabelUr);
    return { title: lines.title, body: lines.body, listenText: `${linesUr.title}. ${linesUr.body}` };
  }
  if (spray.state === 'no-crop' || spray.state === 'no-data') {
    const lines = sprayAdviceLines(ctx.t, spray, startLabel, endLabel);
    const linesUr = sprayAdviceLines(ctx.tUr, spray, startLabelUr, endLabelUr);
    return { title: lines.title, body: lines.body, listenText: `${linesUr.title}. ${linesUr.body}` };
  }

  /* A window: short, standard, or numbered — the numbers never change. */
  if (level === 'simple') {
    return {
      title: ctx.t('advisory.spray.simple', { day, start: startLabel, end: endLabel }),
      body: ctx.t('advisory.spray.simpleBody'),
      listenText: `${ctx.tUr('advisory.spray.simple', { day: dayUr, start: startLabelUr, end: endLabelUr })}. ${ctx.tUr('advisory.spray.simpleBody')}`,
    };
  }
  if (level === 'detailed') {
    const values = {
      day,
      start: startLabel,
      end: endLabel,
      wind: item.windowWindKph ?? '',
      temp: item.windowTempC ?? '',
      humidity: item.windowHumidityPct ?? '',
      deltaT: item.windowDeltaT ?? '',
    };
    const valuesUr = {
      day: dayUr,
      start: startLabelUr,
      end: endLabelUr,
      wind: item.windowWindKph ?? '',
      temp: item.windowTempC ?? '',
      humidity: item.windowHumidityPct ?? '',
      deltaT: item.windowDeltaT ?? '',
    };
    return {
      title: ctx.t('advisory.spray.detailed', values),
      body: ctx.t('advisory.spray.detailedBody'),
      listenText: `${ctx.tUr('advisory.spray.detailed', valuesUr)}. ${ctx.tUr('advisory.spray.detailedBody')}`,
    };
  }
  const lines = sprayAdviceLines(ctx.t, spray, startLabel, endLabel);
  const linesUr = sprayAdviceLines(ctx.tUr, spray, startLabelUr, endLabelUr);
  return { title: lines.title, body: lines.body, listenText: `${linesUr.title}. ${linesUr.body}` };
}

/**
 * An insight-backed item, level-shaped rather than reworded: the knowledge
 * base wrote the words, so `simple` shows the action only, `standard` the
 * body, and `detailed` the body plus the action.
 */
function insightCopy(
  item: AdvisoryItem,
  level: CapabilityLevel,
  ctx: AdvisoryCopyCtx,
): AdvisoryCopy {
  const title = item.titleKey !== undefined ? ctx.t(item.titleKey) : '';
  const titleUr = item.titleKey !== undefined ? ctx.tUr(item.titleKey) : '';
  const body = item.bodyKey !== undefined ? ctx.t(item.bodyKey) : '';
  const bodyUr = item.bodyKey !== undefined ? ctx.tUr(item.bodyKey) : '';
  const action = item.actionKey !== undefined ? ctx.t(item.actionKey) : '';
  const actionUr = item.actionKey !== undefined ? ctx.tUr(item.actionKey) : '';
  if (level === 'simple') {
    return { title, body: action || body, listenText: `${titleUr}. ${actionUr || bodyUr}` };
  }
  if (level === 'detailed') {
    const full = action ? `${body} ${action}` : body;
    const fullUr = actionUr ? `${bodyUr} ${actionUr}` : bodyUr;
    return { title, body: full, listenText: `${titleUr}. ${fullUr}` };
  }
  return { title, body, listenText: `${titleUr}. ${bodyUr}` };
}

function levelBody(
  key: (level: CapabilityLevel) => MessageKey,
  level: CapabilityLevel,
  ctx: AdvisoryCopyCtx,
  values?: Record<string, string | number>,
  valuesUr?: Record<string, string | number>,
): { body: string; bodyUr: string } {
  return {
    body: ctx.t(key(level), values),
    bodyUr: ctx.tUr(key(level), valuesUr ?? values),
  };
}

export function renderAdvisoryCopy(
  item: AdvisoryItem,
  level: CapabilityLevel,
  ctx: AdvisoryCopyCtx,
): AdvisoryCopy {
  switch (item.kind) {
    case 'spray':
      return sprayCopy(item, level, ctx);

    case 'rainfree': {
      const hour = item.rainAtMs !== undefined ? new Date(item.rainAtMs).getHours() : null;
      const at = hour !== null ? ctx.formatHour(hour) : '';
      const atUr = hour !== null ? ctx.formatHourUr(hour) : '';
      const { body, bodyUr } = levelBody(
        (l) =>
          l === 'simple'
            ? 'advisory.rainfree.simple'
            : l === 'detailed'
              ? 'advisory.rainfree.detailed'
              : 'advisory.rainfree.standard',
        level,
        ctx,
        { time: at, hours: RAINFAST_HOURS },
        { time: atUr, hours: RAINFAST_HOURS },
      );
      return {
        title: ctx.t('advisory.rainfree.title'),
        body,
        listenText: `${ctx.tUr('advisory.rainfree.title')}. ${bodyUr}`,
      };
    }

    case 'outbreak': {
      const place = item.placeLabel ?? '';
      const { body, bodyUr } = levelBody(
        (l) =>
          l === 'simple'
            ? 'advisory.outbreak.simple'
            : l === 'detailed'
              ? 'advisory.outbreak.detailed'
              : 'advisory.outbreak.standard',
        level,
        ctx,
        { place },
      );
      return {
        title: ctx.t('advisory.outbreak.title'),
        body,
        listenText: `${ctx.tUr('advisory.outbreak.title')}. ${bodyUr}`,
      };
    }

    case 'pestThreshold': {
      const place = item.placeLabel ?? '';
      const { body, bodyUr } = levelBody(
        (l) =>
          l === 'simple'
            ? 'advisory.pestThreshold.simple'
            : l === 'detailed'
              ? 'advisory.pestThreshold.detailed'
              : 'advisory.pestThreshold.standard',
        level,
        ctx,
        { place },
      );
      return {
        title: ctx.t('advisory.pestThreshold.title'),
        body,
        listenText: `${ctx.tUr('advisory.pestThreshold.title')}. ${bodyUr}`,
      };
    }

    case 'stress': {
      /* Crop-specific: the knowledge base wrote it, so shape it, don't reword it. */
      if (item.insightId !== undefined) return insightCopy(item, level, ctx);
      const mode = item.stressMode ?? 'heat';
      const temp = item.tempC ?? '';
      const titleKey: MessageKey =
        mode === 'heat' ? 'advisory.stress.heat.title' : 'advisory.stress.cold.title';
      const { body, bodyUr } = levelBody(
        (l) =>
          mode === 'heat'
            ? l === 'simple'
              ? 'advisory.stress.heat.simple'
              : l === 'detailed'
                ? 'advisory.stress.heat.detailed'
                : 'advisory.stress.heat.standard'
            : l === 'simple'
              ? 'advisory.stress.cold.simple'
              : l === 'detailed'
                ? 'advisory.stress.cold.detailed'
                : 'advisory.stress.cold.standard',
        level,
        ctx,
        { temp },
      );
      return {
        title: ctx.t(titleKey),
        body,
        listenText: `${ctx.tUr(titleKey)}. ${bodyUr}`,
      };
    }

    case 'harvest': {
      const mode = item.harvestMode ?? 'ready';
      const titleKey: MessageKey =
        mode === 'ready' ? 'advisory.harvest.ready.title' : 'advisory.harvest.beforeRain.title';
      const hour = item.rainAtMs !== undefined ? new Date(item.rainAtMs).getHours() : null;
      const at = hour !== null ? ctx.formatHour(hour) : '';
      const atUr = hour !== null ? ctx.formatHourUr(hour) : '';
      const { body, bodyUr } = levelBody(
        (l) =>
          mode === 'ready'
            ? l === 'simple'
              ? 'advisory.harvest.ready.simple'
              : l === 'detailed'
                ? 'advisory.harvest.ready.detailed'
                : 'advisory.harvest.ready.standard'
            : l === 'simple'
              ? 'advisory.harvest.beforeRain.simple'
              : l === 'detailed'
                ? 'advisory.harvest.beforeRain.detailed'
                : 'advisory.harvest.beforeRain.standard',
        level,
        ctx,
        { time: at, days: HARVEST_DRY_DAYS },
        { time: atUr, days: HARVEST_DRY_DAYS },
      );
      return {
        title: ctx.t(titleKey),
        body,
        listenText: `${ctx.tUr(titleKey)}. ${bodyUr}`,
      };
    }

    case 'stage':
    case 'fertilizer':
      return insightCopy(item, level, ctx);

    case 'irrigation': {
      const mode = item.irrigationMode ?? 'now';
      const titleKey: MessageKey =
        mode === 'skip' ? 'advisory.irrigation.skip.title' : 'advisory.irrigation.now.title';
      const { body, bodyUr } = levelBody(
        (l) =>
          mode === 'skip'
            ? l === 'simple'
              ? 'advisory.irrigation.skip.simple'
              : l === 'detailed'
                ? 'advisory.irrigation.skip.detailed'
                : 'advisory.irrigation.skip.standard'
            : l === 'simple'
              ? 'advisory.irrigation.now.simple'
              : l === 'detailed'
                ? 'advisory.irrigation.now.detailed'
                : 'advisory.irrigation.now.standard',
        level,
        ctx,
        { days: DRY_SPELL_DAYS },
        { days: DRY_SPELL_DAYS },
      );
      return {
        title: ctx.t(titleKey),
        body,
        listenText: `${ctx.tUr(titleKey)}. ${bodyUr}`,
      };
    }

    case 'followup': {
      const mode = item.followupMode ?? 'checkLeaves';
      const titleKey: MessageKey =
        mode === 'checkLeaves'
          ? 'advisory.followup.checkLeaves.title'
          : 'advisory.followup.expertAnswered.title';
      const { body, bodyUr } = levelBody(
        (l) =>
          mode === 'checkLeaves'
            ? l === 'simple'
              ? 'advisory.followup.checkLeaves.simple'
              : l === 'detailed'
                ? 'advisory.followup.checkLeaves.detailed'
                : 'advisory.followup.checkLeaves.standard'
            : l === 'simple'
              ? 'advisory.followup.expertAnswered.simple'
              : l === 'detailed'
                ? 'advisory.followup.expertAnswered.detailed'
                : 'advisory.followup.expertAnswered.standard',
        level,
        ctx,
      );
      return {
        title: ctx.t(titleKey),
        body,
        listenText: `${ctx.tUr(titleKey)}. ${bodyUr}`,
      };
    }

    case 'noCrop': {
      const lines = sprayAdviceLines(ctx.t, {
        state: 'no-crop',
        category: 'weather',
        level: 'info',
        priority: 20,
        windowStartMs: null,
        windowEndMs: null,
        day: null,
        reason: 'no-crop',
      } as SprayAdvice, '', '');
      const linesUr = sprayAdviceLines(ctx.tUr, {
        state: 'no-crop',
        category: 'weather',
        level: 'info',
        priority: 20,
        windowStartMs: null,
        windowEndMs: null,
        day: null,
        reason: 'no-crop',
      } as SprayAdvice, '', '');
      return { title: lines.title, body: lines.body, listenText: `${linesUr.title}. ${linesUr.body}` };
    }

    case 'noData': {
      const lines = sprayAdviceLines(ctx.t, {
        state: 'no-data',
        category: 'weather',
        level: 'info',
        priority: 20,
        windowStartMs: null,
        windowEndMs: null,
        day: null,
        reason: 'no-data',
      } as SprayAdvice, '', '');
      const linesUr = sprayAdviceLines(ctx.tUr, {
        state: 'no-data',
        category: 'weather',
        level: 'info',
        priority: 20,
        windowStartMs: null,
        windowEndMs: null,
        day: null,
        reason: 'no-data',
      } as SprayAdvice, '', '');
      return { title: lines.title, body: lines.body, listenText: `${linesUr.title}. ${linesUr.body}` };
    }
  }
}
