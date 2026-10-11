import type { PriceBucketId, RestaurantSummary, Tier } from '../content/model';

export const PRICE_LABELS: Record<PriceBucketId, string> = {
  '1': '$15 以下',
  '2': '$15–30',
  '3': '$30–60',
  '4': '$60 以上',
};

export const TIER_HINT = '个人评级，从高到低：夯 > 顶级 > 人上人 > npc > 拉完了';

export const TIER_STYLES: Record<Tier, string> = {
  夯: 'bg-chili-600 text-white',
  顶级: 'bg-chili-100 text-chili-700',
  人上人: 'bg-amber-100 text-amber-800',
  npc: 'bg-stone-200 text-stone-700',
  拉完了: 'bg-stone-700 text-stone-100',
};

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
