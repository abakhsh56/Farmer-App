import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Bell, Copy, QrCode } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SectionLabel } from '@/components/SectionLabel';
import { useLocale } from '@/i18n/LocaleProvider';
import { serviceConfig } from '@/services/config';
import { requestShopOwnerPush } from '@/services/push';
import { getSupabaseClient } from '@/services/supabaseClient';
import { formatJoinCode, joinLink } from './joinLink';

/**
 * The shop's own code, drawn as a QR.
 *
 * Shown only to the shop that owns the screen: the issuing function refuses every
 * other party, and the card renders nothing rather than an empty box when it is
 * refused. That is why this can sit on a shop's page without a role flag — the
 * server decides who sees it, and the screen merely reports what it was given.
 *
 * The link inside the QR is a plain HTTPS URL, so a farmer without the app yet
 * still lands somewhere useful after scanning with any camera.
 */
export function ShopQrCard({ dealerId }: { dealerId: string }) {
  const { t } = useLocale();
  const [code, setCode] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [owned, setOwned] = useState<boolean | null>(null);
  const [push, setPush] = useState<'idle' | 'on' | 'denied' | 'failed'>('idle');

  useEffect(() => {
    let cancelled = false;

    const issue = async () => {
      if (!serviceConfig.supabase.configured) {
        if (!cancelled) setOwned(false);
        return;
      }

      try {
        const client = await getSupabaseClient(serviceConfig.supabase);
        if (!client) {
          if (!cancelled) setOwned(false);
          return;
        }

        const { data, error } = await client.rpc('issue_shop_join_code', { p_dealer_id: dealerId });

        if (error || cancelled) {
          if (!cancelled) setOwned(false);
          return;
        }

        const row = (Array.isArray(data) ? data[0] : data) as { code: string } | null;
        if (!row?.code) {
          if (!cancelled) setOwned(false);
          return;
        }

        if (!cancelled) {
          setOwned(true);
          setCode(row.code);
        }
      } catch {
        if (!cancelled) setOwned(false);
      }
    };

    void issue();
    return () => {
      cancelled = true;
    };
  }, [dealerId]);

  /*
   * Drawn after the code arrives, not during render: `toDataURL` is asynchronous
   * and its promise must not resolve into an unmounted card.
   */
  useEffect(() => {
    if (!code) return;
    let cancelled = false;

    QRCode.toDataURL(joinLink(code, window.location.origin), {
      margin: 1,
      width: 320,
      errorCorrectionLevel: 'M',
      color: { dark: '#1F2A17', light: '#FAF9F5' },
    })
      .then((url) => {
        if (!cancelled) setImage(url);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('shop.qr.failed'));
      });

    return () => {
      cancelled = true;
    };
  }, [code, t]);

  if (owned !== true || !code) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatJoinCode(code));
      toast.success(t('shop.qr.copied'));
    } catch {
      /* Clipboard refusal is not worth a failure message; the code is on screen. */
    }
  };

  return (
    <section className="mt-6">
      <SectionLabel>{t('shop.qr.title')}</SectionLabel>
      <div className="mt-2 flex items-center gap-4 rounded-2xl border border-border bg-card p-4">
        {image ? (
          <img
            src={image}
            alt=""
            width={112}
            height={112}
            className="size-28 shrink-0 rounded-xl bg-background"
          />
        ) : (
          <div className="grid size-28 shrink-0 place-items-center rounded-xl bg-muted" aria-hidden>
            <QrCode className="size-8 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{t('shop.qr.body')}</p>
          <p className="mt-1 font-mono text-lg tracking-wider">{formatJoinCode(code)}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={copy}>
            <Copy className="size-4" aria-hidden />
            {t('shop.qr.copy')}
          </Button>
        </div>
      </div>

      {/*
        Asked for here, beside the code, because this is the one place where the
        reason is obvious: "a farmer just joined" is the notification itself.
      */}
      <div className="mt-3 rounded-2xl border border-border bg-card p-4">
        <p className="text-sm font-medium">{t('shop.push.title')}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {push === 'denied' ? t('shop.push.denied') : t('shop.push.body')}
        </p>
        {push === 'on' ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('shop.push.on')}</p>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={async () => {
              const result = await requestShopOwnerPush();
              if (result.status === 'registered') {
                setPush('on');
                return;
              }
              if (result.status === 'denied') {
                setPush('denied');
                return;
              }
              if (result.status === 'unsupported') return;
              toast.error(t('shop.push.failed'));
              setPush('failed');
            }}
          >
            <Bell className="size-4" aria-hidden />
            {t('shop.push.enable')}
          </Button>
        )}
      </div>
    </section>
  );
}
