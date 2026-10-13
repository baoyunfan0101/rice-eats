// Display labels for the database's controlled values (keys defined in
// shared/content/vocabulary.ts). Presentation only: rewording a label never
// requires changing restaurant data. Record types make a missing label a type error.

import type { CuisineId, Rating, TagId, Verdict } from '../../shared/content/vocabulary';

export const CUISINE_LABELS: Record<CuisineId, string> = {
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
};

export const TAG_LABELS: Record<TagId, string> = {
  budget: '实惠',
  date: '适合约会',
  group: '适合聚餐',
  'late-night': '营业到很晚',
  quick: '出餐快',
  solo: '适合一人食',
  spicy: '偏辣',
  study: '适合学习',
};

export const RATING_LABELS: Record<Rating, string> = {
  5: '🥵 夯',
  4: '😘 顶级',
  3: '🤤 人上人',
  2: '🫤 NPC',
  1: '🤮 拉完了',
};

export const VERDICT_LABELS: Record<Verdict, string> = { 1: '🔥 推荐', [-1]: '💣 避雷' };

/** Label for a stored key; unknown keys (none pass validation) fall back to the key. */
export const cuisineLabel = (id: string) => CUISINE_LABELS[id as CuisineId] ?? id;
export const tagLabel = (id: string) => TAG_LABELS[id as TagId] ?? id;
