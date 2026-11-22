import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLocale } from '@/i18n/LocaleProvider';
import { formatJoinCode } from './joinLink';
import type { JoinState } from './useShopJoin';

/**
 * What the farmer sees after pointing a camera at a shop's code.
 *
 * Two states matter and they are different sentences: a first join ("you joined
 * this shop") and a repeat scan ("you are already connected"). Saying "already
 * joined" to a first-time joiner reads as a failure, and saying "joined" to a
 * repeat scan reads as if nothing happened.
 */
export function ShopJoinDialog({
  state,
  onClose,
  onOpenShop,
}: {
  state: JoinState;
  onClose: () => void;
  onOpenShop: (dealerId: string) => void;
}) {
  const { t } = useLocale();

  const open = state.status === 'joining' || state.status === 'joined' || state.status === 'failed';

  const title =
    state.status === 'joined'
      ? state.alreadyJoined
        ? t('shop.join.already', { shop: state.shopName })
        : t('shop.join.joined', { shop: state.shopName })
      : t('shop.join.title');

  const body =
    state.status === 'joined'
      ? t('shop.qr.body')
      : state.status === 'failed'
        ? state.reason === 'expired'
          ? t('shop.join.failed')
          : t('shop.join.unavailable')
        : t('shop.join.body', {
            shop: state.status === 'joining' ? formatJoinCode(state.code) : '',
          });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {state.status === 'joined' ? (
            <Button
              onClick={() => {
                onOpenShop(state.dealerId);
                onClose();
              }}
            >
              {t('common.seeAll')}
            </Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              {t('common.close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
