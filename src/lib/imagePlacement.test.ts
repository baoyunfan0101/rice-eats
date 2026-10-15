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
const dish = (name: string, imageIndexes: number[] = [], extra: Partial<Dish> = {}): Dish => ({
  name,
  imageIndexes,
  ...extra,
});

describe('image placement', () => {
  it('shows a cover that the review also places only in the review', () => {
    const p = placeImages({ images: images(2), dishes: [], reviewImageIndexes: [0] });
    expect(p.hero).toBeUndefined();
    expect(src(p.gallery)).toEqual(['/1.webp']);
  });

  it('shows every photo of a dish in its card, in order, with numbered alt text', () => {
    const dishes = [dish('小笼包', [1, 2, 3], { verdict: 1 }), dish('红烧肉', [4, 5])];
    const p = placeImages({ images: images(6), dishes, reviewImageIndexes: [] });
    expect(p.dishImages.map(src)).toEqual([
      ['/1.webp', '/2.webp', '/3.webp'],
      ['/4.webp', '/5.webp'],
    ]);
    expect(p.dishImages[0]!.map((i) => i.alt)).toEqual([
      '小笼包（1/3）',
      '小笼包（2/3）',
      '小笼包（3/3）',
    ]);
    expect(p.dishImages[1]!.map((i) => i.alt)).toEqual(['红烧肉（1/2）', '红烧肉（2/2）']);
    expect(src([p.hero])).toEqual(['/0.webp']);
    expect(p.gallery).toEqual([]);
  });

  it('never hides a dish photo, even when it is the cover or in the review', () => {
    const dishes = [dish('Noodles', [0, 1])];
    const p = placeImages({ images: images(3), dishes, reviewImageIndexes: [1] });
    expect(src([p.hero])).toEqual(['/0.webp']);
    expect(p.dishImages.map(src)).toEqual([['/0.webp', '/1.webp']]);
    expect(p.dishImages[0]![0]!.alt).toBe('Noodles（1/2）');
    // The gallery only has what is shown nowhere else.
    expect(src(p.gallery)).toEqual(['/2.webp']);
  });

  it('describes a single dish photo by the dish name', () => {
    const p = placeImages({
      images: images(2),
      dishes: [dish('Tea', [1])],
      reviewImageIndexes: [],
    });
    expect(p.dishImages[0]!.map((i) => i.alt)).toEqual(['Tea']);
  });

  it('handles photos used only in the review, only in dishes, or nowhere', () => {
    const p = placeImages({
      images: images(5),
      dishes: [dish('Dish', [2])],
      reviewImageIndexes: [3, 1],
    });
    expect(src([p.hero])).toEqual(['/0.webp']);
    expect(p.dishImages.map(src)).toEqual([['/2.webp']]);
    expect(src(p.gallery)).toEqual(['/4.webp']); // remaining photos in stored order
  });

  it('shows every photo of an image-only restaurant: cover first, the rest in order', () => {
    const p = placeImages({ images: images(3), dishes: [], reviewImageIndexes: [] });
    expect(src([p.hero, ...p.gallery])).toEqual(['/0.webp', '/1.webp', '/2.webp']);
  });

  it('ignores repeated or unknown indexes', () => {
    const p = placeImages({
      images: images(2),
      dishes: [dish('x', [1, 1, 7])],
      reviewImageIndexes: [],
    });
    expect(p.dishImages.map(src)).toEqual([['/1.webp']]);
  });

  it('handles restaurants without photos', () => {
    const p = placeImages({ images: [], dishes: [dish('Tea')], reviewImageIndexes: [] });
    expect(p).toEqual({ hero: undefined, dishImages: [[]], gallery: [] });
  });

  it('is deterministic', () => {
    const r = { images: images(4), dishes: [dish('x', [2, 3])], reviewImageIndexes: [1] };
    expect(placeImages(r)).toEqual(placeImages(r));
  });
});
