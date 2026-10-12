// Decides where each restaurant photo appears on the detail page, so a stored
// photo is shown once even when several parts of the data refer to it.
//
// Priority (highest first):
//   1. review.md  explicit editorial placement; every placement is kept, so an
//                 author can repeat a photo on purpose inside the review.
//   2. hero       the cover (images[0]), unless the review already places it.
//   3. dish card  the dish's photo, unless shown by 1 or 2 or an earlier dish;
//                 the card keeps its name, verdict, and comment either way.
//   4. gallery    every remaining photo, in stored order.
// List, grid, and map previews always use the cover; this policy only applies
// to the detail page.

import type { ImageAsset, RestaurantDetail } from '../../shared/content/model';

export interface ImagePlacement {
  hero?: ImageAsset;
  /** One entry per dish, aligned with `dishes`. */
  dishImages: (ImageAsset | undefined)[];
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
    const i = dish.imageIndex;
    if (i === undefined || used.has(i) || !r.images[i]) return undefined;
    used.add(i);
    return { ...r.images[i], alt: dish.name };
  });
  const gallery = r.images.filter((_, i) => !used.has(i));
  return { hero, dishImages, gallery };
}
