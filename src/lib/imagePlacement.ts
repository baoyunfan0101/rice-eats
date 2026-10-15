// Decides where each restaurant photo appears on the detail page.
//
// Placement (in this order):
//   1. review.md  explicit editorial placement; every placement is kept, so an
//                 author can repeat a photo on purpose inside the review.
//   2. hero       the cover (images[0]), unless the review already places it.
//   3. dish card  every photo of the dish, in its stored order. A dish's photos
//                 are part of the dish (structured data), so they are never
//                 hidden by the other places: a dish photo that is also the
//                 cover or appears in the review still shows in its card.
//   4. gallery    every photo not shown above, in stored order, so nothing
//                 is shown twice outside the dish cards.
// List, grid, and map previews always use the cover; this policy only applies
// to the detail page.

import type { ImageAsset, RestaurantDetail } from '../../shared/content/model';

export interface ImagePlacement {
  hero?: ImageAsset;
  /** One entry per dish, aligned with `dishes`: all of its photos, possibly none. */
  dishImages: ImageAsset[][];
  gallery: ImageAsset[];
}

export function placeImages(
  r: Pick<RestaurantDetail, 'images' | 'dishes' | 'reviewImageIndexes'>,
): ImagePlacement {
  const used = new Set<number>(r.reviewImageIndexes);
  let hero: ImageAsset | undefined;
  if (r.images.length > 0 && !used.has(0)) {
    hero = r.images[0];
    used.add(0);
  }
  const dishImages = r.dishes.map((dish) => {
    const indexes = [...new Set(dish.imageIndexes)].filter((i) => r.images[i]);
    indexes.forEach((i) => used.add(i));
    return indexes.map((i, n) => ({
      ...r.images[i]!,
      alt: indexes.length > 1 ? `${dish.name}（${n + 1}/${indexes.length}）` : dish.name,
    }));
  });
  const gallery = r.images.filter((_, i) => !used.has(i));
  return { hero, dishImages, gallery };
}
