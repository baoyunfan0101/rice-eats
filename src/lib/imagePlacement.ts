// Decides where each restaurant photo appears on the detail page.
//
// Every photo belongs to one review (scripts/content/pipeline.ts checks it):
//   hero        the cover (images[0]).
//   dish card   every photo of the dish, from every review (newest first);
//               the dish's panel shows each review's photos with its words.
//   review      the review's own photos (not of one dish).
//   gallery     every photo no review uses (added by the maintainer), in
//               stored order, so nothing stored is hidden.
// List, grid, and map previews always use the cover; this policy only applies
// to the detail page.

import type { ImageAsset, RestaurantDetail } from '../../shared/content/model';

export interface ImagePlacement {
  hero?: ImageAsset;
  gallery: ImageAsset[];
}

export function placeImages(
  r: Pick<RestaurantDetail, 'images' | 'dishes' | 'reviews'>,
): ImagePlacement {
  const used = new Set<number>([0]);
  for (const dish of r.dishes) dish.imageIndexes.forEach((i) => used.add(i));
  for (const review of r.reviews) review.imageIndexes.forEach((i) => used.add(i));
  return { hero: r.images[0], gallery: r.images.filter((_, i) => !used.has(i)) };
}

/** The images at these indexes (each once, in order); `alt` names a dish's photos "name（n/N）". */
export function imagesAt(
  r: Pick<RestaurantDetail, 'images'>,
  indexes: number[],
  alt?: string,
): ImageAsset[] {
  const valid = [...new Set(indexes)].filter((i) => r.images[i]);
  return valid.map((i, n) => ({
    ...r.images[i]!,
    ...(alt ? { alt: valid.length > 1 ? `${alt}（${n + 1}/${valid.length}）` : alt } : {}),
  }));
}
