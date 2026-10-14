import type { RestaurantSummary } from '../../shared/content/model';
import { RATINGS, type Rating } from '../../shared/content/vocabulary';
import { cuisineLabel, RATING_LABELS } from './labels';

export { RATING_LABELS };

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

/** "日本菜 / 拉面 · 人均 $18" */
export function metaLine(r: RestaurantSummary): string {
  return [r.cuisines.map(cuisineLabel).join(' / '), priceText(r.pricePerPerson)]
    .filter(Boolean)
    .join(' · ');
}

/** Other names, shown under the main name. */
export function secondaryNames(r: Pick<RestaurantSummary, 'altNames'>): string[] {
  return r.altNames;
}
