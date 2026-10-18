import type { RestaurantSummary } from '../../shared/content/model';
import { RATINGS, type Rating } from '../../shared/content/vocabulary';
import { cuisineLabel, RATING_LABELS } from './labels';

export { RATING_LABELS };

export const RATING_STYLES: Record<Rating, string> = {
  // Light backgrounds keep the emoji readable; the hue runs from hot to cold.
  5: 'bg-chili-100 text-chili-700',
  4: 'bg-chili-50 text-chili-700',
  3: 'bg-gold-100 text-gold-700',
  2: 'bg-basil-50 text-basil-600',
  1: 'bg-sand text-muted',
};

export const RATING_HINT = `评级，从高到低：${RATINGS.map((r) => RATING_LABELS[r]).join(' > ')}`;

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
