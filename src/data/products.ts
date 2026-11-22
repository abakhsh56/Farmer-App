import type { MessageKey } from '@/i18n/catalog';

/**
 * Canonical products — the identity a recommendation points at.
 *
 * This file is the *knowledge* half of the chain the PRD requires:
 *
 *   crop problem → approved treatment → **canonical product** → live dealer
 *   listings → location/availability → farmer result
 *
 * The knowledge half is what the app knows and can cite: the product's name, the
 * problem it is approved for, and the registration number that is the evidence.
 * The inventory half — who has it, at what price, confirmed when — is not here
 * any more. It lives in the dealer projection and is read through the dealer
 * service (`stockists`), because a listing written next to a treatment is a
 * listing that quietly becomes the reason the treatment was chosen, and the two
 * copies of a price drift apart on two different screens.
 *
 * `id` is the product's stable slug: the same identifier the dealer system files
 * its products under, so the knowledge layer and the inventory layer meet on a
 * value neither of them owns.
 *
 * The catalogue is deliberately partial. A product a dealer lists with no entry
 * here is still purchasable and still shown in full — its price, pack, stock and
 * registration come from the dealer system — and the product page says that the
 * approved-use description is not available yet. That is the honest state while
 * the knowledge build is still being extended crop by crop, and it is the same
 * rule as an unsupported crop: say so rather than manufacture guidance.
 */

export type CanonicalProduct = {
  /** Stable slug, shared with the dealer projection. */
  id: string;
  nameKey: MessageKey;
  /** Where the claim that this is an approved treatment comes from. */
  sourceKey: MessageKey;
  /** Registration number as published in the DPP registered-pesticide list. */
  registration: string;
  /** The problem this product is approved for, by canonical name. */
  problemKey: MessageKey;
  /** Manufacturer, as the source reports it. A proper noun: not translated. */
  manufacturer: string;
  /** What kind of input this is — a fungicide, a fertiliser, a seed. */
  categoryKey: MessageKey;
  /** The active ingredient, when the product is a formulated chemical. */
  activeIngredient?: string;
  /** What the product is, in the app's own words. */
  descriptionKey: MessageKey;
  /** What it is approved to be used for, stated conservatively. */
  useKey: MessageKey;
  /** The safety line that must travel with the product, not with the dealer. */
  safetyKey: MessageKey;
  /** Pack sizes the catalogue knows about. The dealer's listing wins for price. */
  packSizes?: readonly string[];
};

export const ROUNDUP: CanonicalProduct = {
  id: 'roundup',
  nameKey: 'product.roundup',
  sourceKey: 'source.dpp',
  registration: 'DPP-PK-2019-0431',
  problemKey: 'insight.pest.title',
  manufacturer: 'Bayer',
  categoryKey: 'catalogue.category.herbicide',
  activeIngredient: 'Glyphosate 41% SL',
  descriptionKey: 'catalogue.roundup.desc',
  useKey: 'catalogue.roundup.use',
  safetyKey: 'catalogue.roundup.safety',
  packSizes: ['1 L', '4 L'],
};

export const CONFIDOR: CanonicalProduct = {
  id: 'confidor',
  nameKey: 'catalogue.confidor.name',
  sourceKey: 'source.dpp',
  registration: 'DPP-PK-2017-0228',
  problemKey: 'insight.pest.title',
  manufacturer: 'Bayer',
  categoryKey: 'catalogue.category.insecticide',
  activeIngredient: 'Imidacloprid 200 SL',
  descriptionKey: 'catalogue.confidor.desc',
  useKey: 'catalogue.confidor.use',
  safetyKey: 'catalogue.confidor.safety',
  packSizes: ['100 ml', '250 ml'],
};

export const UREA: CanonicalProduct = {
  id: 'urea',
  nameKey: 'catalogue.urea.name',
  sourceKey: 'source.extension',
  registration: 'FERT-PK-UREA-46',
  problemKey: 'catalogue.urea.problem',
  manufacturer: 'Sarsabz (Fatima Fertilizer)',
  categoryKey: 'catalogue.category.fertilizer',
  activeIngredient: 'Nitrogen 46%',
  descriptionKey: 'catalogue.urea.desc',
  useKey: 'catalogue.urea.use',
  safetyKey: 'catalogue.urea.safety',
  packSizes: ['50 kg'],
};

export const SARSABZ_DAP: CanonicalProduct = {
  id: 'sarsabz-dap',
  nameKey: 'catalogue.dap.name',
  sourceKey: 'source.extension',
  registration: 'FERT-PK-DAP-18-46',
  problemKey: 'catalogue.dap.problem',
  manufacturer: 'Sarsabz (Fatima Fertilizer)',
  categoryKey: 'catalogue.category.fertilizer',
  activeIngredient: 'Nitrogen 18%, Phosphate 46%',
  descriptionKey: 'catalogue.dap.desc',
  useKey: 'catalogue.dap.use',
  safetyKey: 'catalogue.dap.safety',
  packSizes: ['50 kg'],
};

export const TILT: CanonicalProduct = {
  id: 'tilt-250',
  nameKey: 'catalogue.tilt.name',
  sourceKey: 'source.dpp',
  registration: 'DPP-PK-2016-0194',
  problemKey: 'catalogue.tilt.problem',
  manufacturer: 'Syngenta',
  categoryKey: 'catalogue.category.fungicide',
  activeIngredient: 'Propiconazole 250 EC',
  descriptionKey: 'catalogue.tilt.desc',
  useKey: 'catalogue.tilt.use',
  safetyKey: 'catalogue.tilt.safety',
  packSizes: ['250 ml'],
};

export const KARATE: CanonicalProduct = {
  id: 'karate',
  nameKey: 'catalogue.karate.name',
  sourceKey: 'source.dpp',
  registration: 'DPP-PK-2018-0352',
  problemKey: 'insight.pest.title',
  manufacturer: 'Syngenta',
  categoryKey: 'catalogue.category.insecticide',
  activeIngredient: 'Lambda-cyhalothrin 2.5 EC',
  descriptionKey: 'catalogue.karate.desc',
  useKey: 'catalogue.karate.use',
  safetyKey: 'catalogue.karate.safety',
  packSizes: ['250 ml', '1 L'],
};

/**
 * The catalogue, keyed by the same slug the dealer system uses.
 *
 * A lookup rather than a list, because every caller arrives with an id: a scan
 * result, a dealer listing, or a product page opened from a shop.
 */
export const CATALOGUE: Readonly<Record<string, CanonicalProduct>> = {
  [ROUNDUP.id]: ROUNDUP,
  [CONFIDOR.id]: CONFIDOR,
  [UREA.id]: UREA,
  [SARSABZ_DAP.id]: SARSABZ_DAP,
  [TILT.id]: TILT,
  [KARATE.id]: KARATE,
};

/** The knowledge entry for a slug, or null when the catalogue does not cover it. */
export function catalogueEntry(id: string | null | undefined): CanonicalProduct | null {
  if (!id) return null;
  return CATALOGUE[id] ?? null;
}
