/**
 * Price buckets of older links (`?price=1..4`), in US dollars per person; the
 * filter itself is now a continuous range (see filters.ts).
 */
export const PRICE_BUCKETS = [
  { id: '1', min: 0, max: 15 },
  { id: '2', min: 15, max: 30 },
  { id: '3', min: 30, max: 60 },
  { id: '4', min: 60, max: Infinity },
] as const;

/**
 * The price slider's range. Its top end means "no upper limit", so a higher
 * price per person is never excluded by the slider; any amount can be typed.
 */
export const PRICE_SLIDER_MAX = 100;
export const PRICE_STEP = 5;

const usd = (value: number) => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;

/** "$15–40", "$15 以上", "$40 以下", or "" for no range. */
export function priceRangeLabel(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined)
    return min === max ? usd(min) : `${usd(min)}–${usd(max).slice(1)}`;
  if (min !== undefined) return `${usd(min)} 以上`;
  if (max !== undefined) return `${usd(max)} 以下`;
  return '';
}
