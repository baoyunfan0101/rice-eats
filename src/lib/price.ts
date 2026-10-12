/** Price buckets used by the price filter, in US dollars per person. */
export const PRICE_BUCKETS = [
  { id: '1', min: 0, max: 15 },
  { id: '2', min: 15, max: 30 },
  { id: '3', min: 30, max: 60 },
  { id: '4', min: 60, max: Infinity },
] as const;
export type PriceBucketId = (typeof PRICE_BUCKETS)[number]['id'];

export function priceBucketOf(price: number | undefined): PriceBucketId | undefined {
  if (price === undefined) return undefined;
  return PRICE_BUCKETS.find((bucket) => price >= bucket.min && price < bucket.max)?.id;
}
