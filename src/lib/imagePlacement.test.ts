import { describe, expect, it } from 'vitest';
import type { Dish, ImageAsset, Review } from '../../shared/content/model';
import { imagesAt, placeImages } from './imagePlacement';

const img = (n: number): ImageAsset => ({
  src: `/${n}.webp`,
  srcset: '',
  width: 1,
  height: 1,
  alt: `photo ${n}`,
});
const images = (count: number) => Array.from({ length: count }, (_, i) => img(i));
const src = (list: (ImageAsset | undefined)[]) => list.map((i) => i?.src);
const dish = (name: string, imageIndexes: number[]): Dish => ({
  id: name,
  name,
  recommend: 0,
  avoid: 0,
  imageIndexes,
  reviews: [],
});
const review = (imageIndexes: number[]): Review => ({
  id: 'u-001',
  contributor: { id: 'u-001', name: 'A' },
  submittedAt: '2026-10-01T12:00:00Z',
  date: '2026-10-01',
  rating: 4,
  html: '',
  imageIndexes,
  dishes: [],
});

describe('image placement', () => {
  it('uses the first photo as the cover and keeps photos no review uses for the gallery', () => {
    const p = placeImages({
      images: images(6),
      dishes: [dish('小笼包', [1, 2])],
      reviews: [review([3])],
    });
    expect(src([p.hero])).toEqual(['/0.webp']);
    expect(src(p.gallery)).toEqual(['/4.webp', '/5.webp']);
  });

  it('has no cover and no gallery without photos', () => {
    expect(placeImages({ images: [], dishes: [], reviews: [] })).toEqual({
      hero: undefined,
      gallery: [],
    });
  });

  it("names a dish's photos with their position, each once and in order", () => {
    const r = { images: images(4) };
    expect(imagesAt(r, [3, 1, 3, 9], '小笼包').map((i) => [i.src, i.alt])).toEqual([
      ['/3.webp', '小笼包（1/2）'],
      ['/1.webp', '小笼包（2/2）'],
    ]);
    expect(imagesAt(r, [2], '红烧肉').map((i) => i.alt)).toEqual(['红烧肉']);
    // Without a name the stored alt text stays.
    expect(imagesAt(r, [2]).map((i) => i.alt)).toEqual(['photo 2']);
  });
});
