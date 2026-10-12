import { describe, expect, it } from 'vitest';
import type { Dish, ImageAsset } from '../../shared/content/model';
import { placeImages } from './imagePlacement';

const img = (n: number): ImageAsset => ({
  src: `/${n}.webp`,
  srcset: '',
  width: 1,
  height: 1,
  alt: `photo ${n}`,
});
const images = (count: number) => Array.from({ length: count }, (_, i) => img(i));
const src = (list: (ImageAsset | undefined)[]) => list.map((i) => i?.src);

/** Every photo shown on the page, counting each placement once (review placements counted once per index). */
function shownOnce(r: { images: ImageAsset[]; dishes: Dish[]; reviewImageIndexes: number[] }) {
  const p = placeImages(r);
  const all = [
    ...r.reviewImageIndexes.map((i) => r.images[i]!.src),
    p.hero?.src,
    ...src(p.dishImages),
    ...src(p.gallery),
  ].filter(Boolean);
  return { p, all };
}

describe('image placement', () => {
  it('shows a cover that the review also places only in the review', () => {
    const { p, all } = shownOnce({ images: images(2), dishes: [], reviewImageIndexes: [0] });
    expect(p.hero).toBeUndefined();
    expect(src(p.gallery)).toEqual(['/1.webp']);
    expect(all).toEqual(['/0.webp', '/1.webp']);
  });

  it('keeps a photo placed in the review out of the dish card, but keeps the dish', () => {
    const dishes: Dish[] = [{ name: 'Noodles', verdict: 1, comment: 'good', imageIndex: 1 }];
    const { p, all } = shownOnce({ images: images(2), dishes, reviewImageIndexes: [1] });
    expect(p.dishImages).toEqual([undefined]);
    expect(src([p.hero])).toEqual(['/0.webp']);
    expect(new Set(all).size).toBe(all.length);
  });

  it('shows the cover in the hero, not again on a dish card that uses it', () => {
    const dishes: Dish[] = [{ name: 'Noodles', imageIndex: 0 }];
    const { p } = shownOnce({ images: images(1), dishes, reviewImageIndexes: [] });
    expect(src([p.hero])).toEqual(['/0.webp']);
    expect(p.dishImages).toEqual([undefined]);
    expect(p.gallery).toEqual([]);
  });

  it('gives a photo shared by several dishes only to the first', () => {
    const dishes: Dish[] = [
      { name: 'A', imageIndex: 2 },
      { name: 'B', imageIndex: 2 },
      { name: 'C', imageIndex: 3 },
    ];
    const { p, all } = shownOnce({ images: images(4), dishes, reviewImageIndexes: [1] });
    expect(p.dishImages.map((i) => i?.src)).toEqual(['/2.webp', undefined, '/3.webp']);
    expect(p.dishImages[0]!.alt).toBe('A'); // dish photos are described by the dish name
    expect(all.sort()).toEqual(['/0.webp', '/1.webp', '/2.webp', '/3.webp']);
  });

  it('handles photos used only in the review, only in dishes, or nowhere', () => {
    const dishes: Dish[] = [{ name: 'Dish', imageIndex: 2 }];
    const { p } = shownOnce({ images: images(5), dishes, reviewImageIndexes: [3, 1] });
    expect(src([p.hero])).toEqual(['/0.webp']);
    expect(src(p.dishImages)).toEqual(['/2.webp']);
    expect(src(p.gallery)).toEqual(['/4.webp']); // remaining photos in stored order
  });

  it('shows every photo of an image-only restaurant: cover first, the rest in order', () => {
    const { p } = shownOnce({ images: images(3), dishes: [], reviewImageIndexes: [] });
    expect(src([p.hero, ...p.gallery])).toEqual(['/0.webp', '/1.webp', '/2.webp']);
  });

  it('handles restaurants without photos', () => {
    const p = placeImages({ images: [], dishes: [{ name: 'Tea' }], reviewImageIndexes: [] });
    expect(p).toEqual({ hero: undefined, dishImages: [undefined], gallery: [] });
  });

  it('is deterministic', () => {
    const r = {
      images: images(4),
      dishes: [{ name: 'x', imageIndex: 2 }],
      reviewImageIndexes: [1],
    };
    expect(placeImages(r)).toEqual(placeImages(r));
  });
});
