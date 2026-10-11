import { RATINGS, type PriceBucketId, type Rating, type RestaurantSummary } from '../content/model';

export const PRICE_LABELS: Record<PriceBucketId, string> = {
  '1': '$15 以下',
  '2': '$15–30',
  '3': '$30–60',
  '4': '$60 以上',
};

/** The only place rating labels are defined; restaurant data stores 1-5. */
export const RATING_LABELS: Record<Rating, string> = {
  5: '夯',
  4: '顶级',
  3: '人上人',
  2: 'NPC',
  1: '拉完了',
};

export const RATING_STYLES: Record<Rating, string> = {
  5: 'bg-chili-600 text-white',
  4: 'bg-chili-100 text-chili-700',
  3: 'bg-amber-100 text-amber-800',
  2: 'bg-stone-200 text-stone-700',
  1: 'bg-stone-700 text-stone-100',
};

export const RATING_HINT = `个人评级，从高到低：${RATINGS.map((r) => RATING_LABELS[r]).join(' > ')}`;

export function priceText(price: number | undefined): string | undefined {
  if (price === undefined) return undefined;
  return `人均 $${Number.isInteger(price) ? price : price.toFixed(1)}`;
}

/** "日本菜 · Rice Village · 人均 $18" */
export function metaLine(r: RestaurantSummary): string {
  return [r.cuisines.join(' / '), r.neighborhood, priceText(r.pricePerPerson)]
    .filter(Boolean)
    .join(' · ');
}
