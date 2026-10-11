// Controlled vocabularies. Restaurant data stores only the language-independent
// keys; the values here are the display labels. To add a cuisine or tag, add
// one line here. Labels can be reworded without touching restaurant data.

import type { Rating } from './model';

export const CUISINE_LABELS = {
  american: '美式',
  bakery: '烘焙',
  bbq: '美式烧烤',
  cantonese: '粤菜',
  chinese: '中餐',
  coffee: '咖啡',
  dessert: '甜品',
  'fast-food': '快餐',
  japanese: '日本菜',
  korean: '韩国菜',
  mexican: '墨西哥菜',
  ramen: '拉面',
  sichuan: '川菜',
  steak: '牛排',
  taiwanese: '台湾菜',
  thai: '泰国菜',
  vietnamese: '越南菜',
} as const satisfies Record<string, string>;
export type CuisineId = keyof typeof CUISINE_LABELS;

/** Scenario tags used for filtering ("good for ..."). */
export const TAG_LABELS = {
  budget: '实惠',
  date: '适合约会',
  group: '适合聚餐',
  'late-night': '营业到很晚',
  quick: '出餐快',
  solo: '适合一人食',
  spicy: '偏辣',
  study: '适合学习',
} as const satisfies Record<string, string>;
export type TagId = keyof typeof TAG_LABELS;

/** Personal rating, 5 (highest) to 1 (lowest). */
export const RATING_LABELS: Record<Rating, string> = {
  5: '夯',
  4: '顶级',
  3: '人上人',
  2: 'NPC',
  1: '拉完了',
};

/** Dish verdict: 1 recommends the dish, -1 warns against it. No verdict means no opinion. */
export const VERDICT_LABELS = { 1: '推荐', [-1]: '避雷' } as Record<1 | -1, string>;

export const CUISINE_IDS = Object.keys(CUISINE_LABELS) as CuisineId[];
export const TAG_IDS = Object.keys(TAG_LABELS) as TagId[];

export const cuisineLabel = (id: string) => (CUISINE_LABELS as Record<string, string>)[id] ?? id;
export const tagLabel = (id: string) => (TAG_LABELS as Record<string, string>)[id] ?? id;
