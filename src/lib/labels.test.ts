import { describe, expect, it } from 'vitest';
import { CUISINE_IDS, RATINGS, TAG_IDS, VERDICTS } from '../../shared/content/vocabulary';
import {
  CUISINE_LABELS,
  RATING_LABELS,
  TAG_LABELS,
  VERDICT_LABELS,
  cuisineLabel,
  tagLabel,
} from './labels';

describe('display labels', () => {
  it('cover exactly the keys of the shared vocabulary', () => {
    expect(Object.keys(CUISINE_LABELS).sort()).toEqual([...CUISINE_IDS].sort());
    expect(Object.keys(TAG_LABELS).sort()).toEqual([...TAG_IDS].sort());
    expect(Object.keys(RATING_LABELS).map(Number).sort()).toEqual([...RATINGS].sort());
    expect(Object.keys(VERDICT_LABELS).map(Number).sort()).toEqual([...VERDICTS].sort());
  });

  it('map keys to Chinese labels', () => {
    expect(cuisineLabel('sichuan')).toBe('川菜');
    expect(tagLabel('date')).toBe('适合约会');
    expect(RATING_LABELS[2]).toBe('🫤 NPC');
    expect(VERDICT_LABELS[1]).toBe('🔥 推荐');
    expect(VERDICT_LABELS[-1]).toBe('💣 避雷');
  });
});
