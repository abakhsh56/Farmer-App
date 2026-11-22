import { PersonalizedAdvice } from '@/components/insights/PersonalizedAdvice';
import { useInsights } from '@/insights/InsightProvider';
import { useSession } from '@/session/SessionProvider';

/**
 * The advice panel that used to sit inside Home's crop card — the "For you" list
 * of server-ranked recommendations, with the reason each one was chosen, the
 * source and the feedback buttons.
 *
 * It moved here (and only here) so Home can be about the farmer's own crop —
 * the crop watch and the scanner — while the personalised feed shares a tab with
 * the neighbours' reports it belongs beside. The rows are the same rows Home
 * used to draw: `insights.personalized`, minus whatever the alert panel already
 * shows, so nothing is said twice.
 *
 * It renders nothing at all unless there is an account, the feed has settled,
 * and there is advice in it — the same conditions Home applied. An empty tab is
 * more honest than a heading with no advice under it.
 */
export function ForYou() {
  const insights = useInsights();
  const { account } = useSession();

  const alertIds = new Set(insights.alerts.map((row) => row.recommendationId));
  const rows = insights.personalized
    .filter((row) => !alertIds.has(row.recommendationId))
    .slice(0, 3);

  if (account === null || insights.personalizationStatus !== 'ready' || rows.length === 0) {
    return null;
  }

  return (
    <section className="mt-3 rounded-lg border border-border bg-card p-4">
      <PersonalizedAdvice rows={rows} onRefresh={insights.refreshPersonalized} />
    </section>
  );
}
