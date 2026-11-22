import { Camera, Send, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SectionLabel } from '@/components/SectionLabel';
import { Button } from '@/components/ui/button';
import { useAiCredits } from '@/aiagent/AiCreditsProvider';
import { diagnosePhoto, respond, type AgentDeps, type AgentReply } from '@/aiagent/agent';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { formatHour, formatMoney, formatNumber, formatRelativeTime } from '@/i18n/format';
import { useLocation } from '@/location/LocationProvider';
import { dealerNameKey } from '@/data/dealers';
import { useServices } from '@/services/registry';
import { isRateQuotable, rateRange, type AiAnswer } from '@/services/types';

type Props = {
  /** The photo half of the same tab, one tap away. */
  onOpenScan: () => void;
  /** The shop list, for a dealer answer that needs following up. */
  onOpenDealers: () => void;
};

type Turn =
  | { id: number; from: 'farmer'; text: string }
  | { id: number; from: 'farmerPhoto'; text: string }
  | { id: number; from: 'assistant'; reply: AgentReply };

/**
 * The assistant.
 *
 * Built to the same rule as every other surface in the app: it may explain, but
 * it may not invent. Weather, prices, dealers and stock come from the services
 * the rest of the app reads, which is why an answer carries a source and an
 * observation time rather than a confident sentence on its own.
 *
 * Two things here are product decisions rather than layout:
 *
 *  · Every turn costs credit, and the cost is charged *before* the request is
 *    made. A farmer who has spent their 100 sees the composer fail with a reason
 *    and the time the allowance returns — not a spinner, and not a silent answer
 *    that the ledger did not record.
 *  · A photo is the expensive action and is charged as one. It is the same
 *    diagnosis service the Scan tab uses, reached from the conversation, so a
 *    farmer who is already talking about a crop does not have to leave.
 */
export function AgentScreen({ onOpenScan, onOpenDealers }: Props) {
  const { t, locale } = useLocale();
  const credits = useAiCredits();
  const services = useServices();
  const location = useLocation();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const nextId = useRef(1);
  const filePicker = useRef<HTMLInputElement>(null);
  const objectUrls = useRef<string[]>([]);

  useEffect(() => () => objectUrls.current.forEach((url) => URL.revokeObjectURL(url)), []);

  /** Everything the router may read, read from the live services at call time. */
  const deps = (): AgentDeps => ({
    ask: (question, context) => services.ai.ask(question, context),
    diagnose: (imageRef, context) => services.ai.diagnose(imageRef, context),
    weather: () => services.weather.current({ lat: location.activePoint.lat, lon: location.activePoint.lon }),
    /*
     * The origin rule is copied from the Shop tab on purpose: a temporary area is
     * passed explicitly, and with no saved location the point in play is passed
     * too. Without it a guest search reaches the server with no origin at all,
     * which is refused — and a refusal must never be shown as "nothing nearby".
     */
    dealers: (radiusKm) =>
      services.dealer.search({
        radiusKm,
        origin: location.dealerOrigin ?? location.activePoint,
      }),
    market: () => services.market.rates(),
    radiusKm: location.radiusKm,
    language: locale,
  });

  const chargeAndAsk = async (text: string) => {
    if (thinking) return;
    if (!credits.spend('chat')) {
      toast.error(t(credits.refusedReason('chat') ?? 'agent.credits.exhausted'));
      return;
    }

    setInput('');
    setThinking(true);
    setTurns((current) => [...current, { id: nextId.current++, from: 'farmer', text }]);

    const reply = await respond(text, deps());
    setTurns((current) => [...current, { id: nextId.current++, from: 'assistant', reply }]);
    setThinking(false);
  };

  const sendPhoto = async (file: File | undefined) => {
    if (!file || thinking) return;
    if (!credits.spend('scan')) {
      toast.error(t(credits.refusedReason('scan') ?? 'agent.credits.exhausted'));
      return;
    }

    const url = URL.createObjectURL(file);
    objectUrls.current.push(url);
    setThinking(true);
    setTurns((current) => [
      ...current,
      { id: nextId.current++, from: 'farmerPhoto', text: file.name },
    ]);

    const reply = await diagnosePhoto(url, deps());
    setTurns((current) => [...current, { id: nextId.current++, from: 'assistant', reply }]);
    setThinking(false);
  };

  const spentShare = Math.round(((credits.allowance - credits.remaining) / credits.allowance) * 100);
  const low = credits.remaining <= credits.costOf('scan');

  return (
    <div className="flex flex-col px-4 pt-4 pb-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-title">{t('agent.title')}</h1>
          <p className="mt-1 text-body-sm text-muted-foreground">{t('agent.intro')}</p>
        </div>
        <button
          type="button"
          onClick={onOpenScan}
          aria-label={t('agent.openScan')}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-muted"
        >
          <Camera className="size-5" aria-hidden />
        </button>
      </header>

      {/* The allowance, always visible: a farmer deciding whether to ask one more
          question should not have to find out by being refused. */}
      <section
        aria-label={t('agent.credits.title')}
        className="mt-3 rounded-lg border border-border bg-card p-3"
      >
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-label text-muted-foreground">{t('agent.credits.title')}</p>
          <p className="text-body-sm font-medium tabular-nums">
            {t('agent.credits.count', {
              left: formatNumber(credits.remaining, locale),
              total: formatNumber(credits.allowance, locale),
            })}
          </p>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={credits.allowance}
          aria-valuenow={credits.remaining}
          aria-label={t('agent.credits.title')}
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={`h-full rounded-full ${low ? 'bg-amber-500' : 'bg-brand'}`}
            style={{ width: `${Math.max(0, 100 - spentShare)}%` }}
          />
        </div>
        <p className="mt-1.5 text-caption text-muted-foreground">
          {low
            ? t('agent.credits.resets', {
                time: formatHour(new Date(credits.resetsAt).getHours(), t),
              })
            : t('agent.credits.costs', {
                chat: credits.costOf('chat'),
                scan: credits.costOf('scan'),
              })}
        </p>
      </section>

      {turns.length === 0 ? (
        <section className="mt-4" aria-label={t('agent.suggestions')}>
          <SectionLabel>{t('agent.suggestions')}</SectionLabel>
          <ul className="mt-2 flex flex-wrap gap-2">
            {(
              [
                { key: 'agent.suggest.weather', prompt: t('agent.suggest.weatherPrompt') },
                { key: 'agent.suggest.dealers', prompt: t('agent.suggest.dealersPrompt') },
                { key: 'agent.suggest.rate', prompt: t('agent.suggest.ratePrompt') },
                { key: 'agent.suggest.pest', prompt: t('agent.suggest.pestPrompt') },
              ] as ReadonlyArray<{ key: MessageKey; prompt: string }>
            ).map(({ key, prompt }) => (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => void chargeAndAsk(prompt)}
                  className="flex items-center gap-1.5 rounded-full bg-muted px-3.5 py-2 text-body-sm font-medium leading-none text-muted-foreground"
                >
                  <Sparkles className="size-3.5" aria-hidden />
                  {t(key)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-4 flex-1 space-y-3" aria-live="polite">
        {turns.map((turn) =>
          turn.from === 'farmer' ? (
            <div key={turn.id} className="flex justify-end">
              <p className="max-w-[85%] rounded-lg bg-brand px-3.5 py-2.5 text-body-sm leading-relaxed text-brand-foreground">
                <span className="sr-only">{t('agent.you')}: </span>
                {turn.text}
              </p>
            </div>
          ) : turn.from === 'farmerPhoto' ? (
            <div key={turn.id} className="flex justify-end">
              <p className="max-w-[85%] rounded-lg bg-brand px-3.5 py-2.5 text-body-sm leading-relaxed text-brand-foreground">
                <span className="sr-only">{t('agent.you')}: </span>
                <Camera className="me-1.5 inline size-3.5" aria-hidden />
                {t('agent.photoSent', { name: turn.text })}
              </p>
            </div>
          ) : (
            <Reply
              key={turn.id}
              reply={turn.reply}
              onOpenDealers={onOpenDealers}
              onOpenScan={onOpenScan}
            />
          ),
        )}

        {thinking ? (
          <div role="status" aria-live="polite" className="flex justify-start">
            <p className="rounded-lg bg-muted px-3.5 py-2.5 text-body-sm text-muted-foreground">
              {t('agent.thinking')}
            </p>
          </div>
        ) : null}
      </div>

      <form
        className="mt-4 flex items-end gap-2 border-t border-border pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void chargeAndAsk(input);
        }}
      >
        <label className="sr-only" htmlFor="agent-composer">
          {t('agent.placeholder')}
        </label>
        <button
          type="button"
          onClick={() => filePicker.current?.click()}
          aria-label={t('agent.attach')}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-muted"
        >
          <Camera className="size-5" aria-hidden />
        </button>
        <input
          ref={filePicker}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(event) => {
            void sendPhoto(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <textarea
          id="agent-composer"
          rows={1}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void chargeAndAsk(input);
            }
          }}
          placeholder={t('agent.placeholder')}
          className="max-h-28 min-h-11 flex-1 resize-none rounded-md bg-muted px-3.5 py-3 text-body placeholder:text-muted-foreground focus-visible:outline-none"
        />
        <Button
          type="submit"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          aria-label={t('agent.send')}
          disabled={thinking || input.trim().length === 0}
        >
          <Send className="size-4 rtl:rotate-180" aria-hidden />
        </Button>
      </form>

      <p className="mt-2 text-caption text-muted-foreground">{t('agent.disclaimer')}</p>
    </div>
  );
}

/* ── one reply, rendered by the source that produced it ───────────────────── */

function Reply({
  reply,
  onOpenDealers,
  onOpenScan,
}: {
  reply: AgentReply;
  onOpenDealers: () => void;
  onOpenScan: () => void;
}) {
  const { t, locale } = useLocale();

  if (reply.kind === 'failed') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] rounded-lg border border-border bg-card px-3.5 py-3">
          <p className="flex items-center gap-1.5 text-body-sm text-amber-700 dark:text-amber-100">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {t('agent.failed')}
          </p>
          <p className="mt-1 text-caption text-muted-foreground">{reply.message}</p>
        </div>
      </div>
    );
  }

  if (reply.kind === 'weather') {
    const reading = reply.reading;
    const numbers: ReadonlyArray<{ key: MessageKey; value: string }> = [
      {
        key: 'agent.stat.temp',
        value:
          reading.data.tempC === null
            ? t('agent.value.unknown')
            : t('agent.value.temp', { value: formatNumber(reading.data.tempC, locale) }),
      },
      {
        key: 'agent.stat.feels',
        value:
          reading.data.feelsLikeC === null
            ? t('agent.value.unknown')
            : t('agent.value.temp', { value: formatNumber(reading.data.feelsLikeC, locale) }),
      },
      {
        key: 'agent.stat.humidity',
        value:
          reading.data.humidityPct === null
            ? t('agent.value.unknown')
            : t('agent.value.percent', { value: formatNumber(reading.data.humidityPct, locale) }),
      },
      {
        key: 'agent.stat.wind',
        value:
          reading.data.windKph === null
            ? t('agent.value.unknown')
            : t('agent.value.wind', { value: formatNumber(reading.data.windKph, locale) }),
      },
    ];

    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] rounded-lg border border-border bg-card px-3.5 py-3">
          <p className="text-body-sm">
            {reading.status === 'failing'
              ? t('agent.weather.unavailable')
              : t('agent.weather.lead', {
                  condition: reading.data.conditionText ?? t('agent.value.unknown'),
                })}
          </p>

          {reading.status === 'failing' ? null : (
            <dl className="mt-2.5 grid grid-cols-2 gap-2">
              {numbers.map(({ key, value }) => (
                <div key={key} className="rounded-md bg-muted px-2.5 py-2">
                  <dt className="text-caption text-muted-foreground">{t(key)}</dt>
                  <dd className="text-body-sm font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          )}

          <Source
            label={reading.sourceLabel}
            age={formatRelativeTime(reading.observedAt, Date.now(), t)}
            stale={reading.freshness !== 'fresh'}
          />
        </div>
      </div>
    );
  }

  if (reply.kind === 'dealers') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] rounded-lg border border-border bg-card px-3.5 py-3">
          <p className="text-body-sm">
            {reply.failed
              ? t('agent.dealers.failed')
              : reply.dealers.length === 0
                ? t('agent.dealers.none', { km: formatNumber(reply.radiusKm, locale) })
                : t('agent.dealers.lead', {
                    count: reply.dealers.length,
                    km: formatNumber(reply.radiusKm, locale),
                  })}
          </p>

          {reply.dealers.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {reply.dealers.slice(0, 5).map((dealer) => {
                const key = dealerNameKey(dealer.id);
                return (
                  <li key={dealer.id} className="rounded-md bg-muted px-2.5 py-2">
                    <p className="text-body-sm font-medium">{key ? t(key) : dealer.name}</p>
                    <p className="text-caption text-muted-foreground">
                      {[
                        t('common.km', { km: formatNumber(dealer.distanceKm, locale) }),
                        dealer.verifiedAt !== null ? t('dealers.verified') : t('dealer.profile.unverified'),
                        dealer.openNow === true
                          ? t('agent.dealers.open')
                          : dealer.openNow === false
                            ? t('agent.dealers.closed')
                            : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <Source
            label={reply.source}
            age={formatRelativeTime(reply.observedAt, Date.now(), t)}
            stale={reply.failed}
          />

          <Button variant="outline" size="sm" className="mt-2.5 h-9 rounded-full" onClick={onOpenDealers}>
            {t('agent.dealers.open')}
          </Button>
        </div>
      </div>
    );
  }

  if (reply.kind === 'market') {
    const now = Date.now();
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] rounded-lg border border-border bg-card px-3.5 py-3">
          <p className="text-body-sm">
            {reply.failed ? t('agent.market.failed') : t('agent.market.lead')}
          </p>
          <ul className="mt-2 space-y-1.5">
            {reply.rates.map((rate) => {
              const range = rateRange([rate]);
              const current = isRateQuotable(rate, now);
              return (
                <li key={`${rate.commodity}-${rate.marketName}`} className="rounded-md bg-muted px-2.5 py-2">
                  <p className="text-body-sm font-medium">
                    {rate.nameKey ? t(rate.nameKey) : rate.nameEn}
                  </p>
                  <p className="text-caption text-muted-foreground">
                    {range
                      ? t('agent.market.range', {
                          min: formatMoney(range.min, locale, t),
                          max: formatMoney(range.max, locale, t),
                          market: rate.marketName,
                        })
                      : t('agent.market.unreported', { market: rate.marketName })}
                  </p>
                  {current ? null : (
                    <p className="text-caption text-amber-700 dark:text-amber-100">
                      {t('agent.market.stale')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <Source label={reply.source} age={formatRelativeTime(reply.observedAt, Date.now(), t)} />
        </div>
      </div>
    );
  }

  if (reply.kind === 'scan') {
    const result = reply.result;
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] rounded-lg border border-border bg-card px-3.5 py-3">
          <p className="text-body-sm font-medium">{t('agent.scan.title')}</p>
          <p className="mt-1 text-body-sm">
            {result.diagnosis ?? t('scan.notCovered.title')}
          </p>
          <p className="mt-1 text-caption text-muted-foreground">
            {t('agent.confidence', { pct: result.confidence })}
          </p>
          {result.uncertaintyKey ? (
            <p className="mt-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-caption text-amber-800 dark:bg-amber-500/20 dark:text-amber-100">
              {t(result.uncertaintyKey)}
            </p>
          ) : null}
          {result.escalate ? (
            <p className="mt-1.5 text-caption text-muted-foreground">{t('agent.escalate')}</p>
          ) : null}
          <Button variant="outline" size="sm" className="mt-2.5 h-9 rounded-full" onClick={onOpenScan}>
            {t('agent.scan.open')}
          </Button>
        </div>
      </div>
    );
  }

  const answer: AiAnswer = reply.answer;
  const refused = answer.gate !== 'agriculture';

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-lg border border-border bg-card px-3.5 py-3">
        {refused ? (
          <p className="text-body-sm">
            {answer.refusalReasonKey ? t(answer.refusalReasonKey) : t('scan.notCovered.title')}
          </p>
        ) : (
          <>
            <p className="whitespace-pre-line text-body-sm leading-relaxed">{answer.text}</p>
            <p className="mt-2 text-caption text-muted-foreground">
              {t('agent.confidence', { pct: answer.confidence })}
            </p>
            {answer.caveats.map((caveat) => (
              <p key={caveat} className="mt-1.5 text-caption text-muted-foreground">
                {caveat}
              </p>
            ))}
            {answer.citations.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {answer.citations.map((citation) => (
                  <li
                    key={`${citation.kind}-${citation.label}`}
                    className="rounded-full bg-brand-soft px-2 py-0.5 text-caption font-medium text-brand"
                  >
                    {citation.label}
                    {citation.version ? ` · v${citation.version}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {answer.escalate ? (
              <p className="mt-2 text-caption text-muted-foreground">{t('agent.escalate')}</p>
            ) : null}
          </>
        )}
        <p className="mt-2 text-caption text-muted-foreground">{t('agent.notExpert')}</p>
      </div>
    </div>
  );
}

function Source({ label, age, stale }: { label: string; age: string; stale?: boolean }) {
  const { t } = useLocale();
  return (
    <p
      className={`mt-2 flex items-center gap-1.5 text-caption ${
        stale ? 'text-amber-700 dark:text-amber-100' : 'text-muted-foreground'
      }`}
    >
      {stale ? <TriangleAlert className="size-3 shrink-0" aria-hidden /> : null}
      {t('agent.source', { source: label, age })}
    </p>
  );
}
