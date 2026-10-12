// The contract between the website, the Tally submission form, and local
// intake (docs/submissions.md): the published form setting, the hidden-field
// names the website fills in, and the answer values intake understands.
// Everything here is public; the form URL is not a secret.

import type { Rating, Verdict } from './content/vocabulary';

/** Hidden fields configured in the Tally form, filled in from the URL. */
export const HIDDEN_FIELDS = {
  restaurantId: 'restaurant_id',
  restaurantNameZh: 'restaurant_name_zh',
  restaurantNameEn: 'restaurant_name_en',
  source: 'source',
} as const;

/** Where a submission was started; sent as the `source` hidden field. */
export const SUBMISSION_SOURCES = ['site', 'restaurant-page'] as const;
export type SubmissionSource = (typeof SUBMISSION_SOURCES)[number];

export interface SubmissionContext {
  source: SubmissionSource;
  restaurantId?: string;
  restaurantNameZh?: string;
  restaurantNameEn?: string;
}

/**
 * Question titles in the Tally form (docs/submissions.md). Intake finds the
 * answers in a Tally CSV export by these titles (a column whose header starts
 * with the title or one of its English aliases), so keep them when editing the form.
 */
export const TALLY_QUESTIONS = {
  restaurantNameZh: ['餐厅中文名', 'chinese name'],
  restaurantNameEn: ['餐厅英文名', 'english name'],
  review: ['你的点评', 'review'],
  photos: ['照片', 'photos'],
  rating: ['总体评级', 'overall rating'],
  displayName: ['署名', 'display name'],
  email: ['联系邮箱', 'contact email'],
  consent: ['发布授权', 'publication consent'],
} as const;

/**
 * Optional dish groups: "菜品1 名称", "菜品1 评价", "菜品1 照片", "菜品1 点评",
 * up to TALLY_DISH_GROUPS. Each group's photos belong to that dish.
 */
export const TALLY_DISH_GROUPS = 5;
export const TALLY_DISH_QUESTIONS = {
  name: '名称',
  verdict: '评价',
  photos: '照片',
  comment: '点评',
} as const;
export const dishQuestion = (group: number, part: keyof typeof TALLY_DISH_QUESTIONS) =>
  `菜品${group} ${TALLY_DISH_QUESTIONS[part]}`;

/** Options of a dish's "评价" question; 不评价 or no answer means no verdict. */
export const TALLY_VERDICT_OPTIONS: Record<string, Verdict | undefined> = {
  推荐: 1,
  避雷: -1,
  不评价: undefined,
};

/** Maps a dish verdict answer to the stored verdict; undefined unless clearly 推荐 or 避雷. */
export function verdictFromAnswer(answer: string | undefined): Verdict | undefined {
  const text = answer?.normalize('NFKC').trim();
  return text ? TALLY_VERDICT_OPTIONS[text] : undefined;
}

/** The single option of the required consent question. */
export const TALLY_CONSENT_OPTION = '我同意';

/**
 * Photo upload limits configured in the form (Tally's free plan allows 10 MB
 * per file): 10 general photos plus 3 per dish group.
 */
export const TALLY_MAX_GENERAL_PHOTOS = 10;
export const TALLY_MAX_DISH_PHOTOS = 3;
export const TALLY_MAX_PHOTOS =
  TALLY_MAX_GENERAL_PHOTOS + TALLY_DISH_GROUPS * TALLY_MAX_DISH_PHOTOS;
export const TALLY_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Options of the optional "overall rating" question, exactly as typed in the
 * Tally form, mapped to the stored rating. Unanswered means no rating.
 */
export const TALLY_RATING_OPTIONS: Record<string, Rating> = {
  夯: 5,
  顶级: 4,
  人上人: 3,
  NPC: 2,
  拉完了: 1,
};

/**
 * Maps a submitted rating answer to the stored rating. Accepts an option label
 * ("夯", any case), its number ("5"), or both ("夯 (5)"). Returns undefined
 * when the question was left unanswered or the answer is not recognized, so
 * an unselected rating never becomes a rating.
 */
export function ratingFromAnswer(answer: string | undefined): Rating | undefined {
  const text = answer?.normalize('NFKC').trim().toLowerCase();
  if (!text) return undefined;
  const byLabel = (label: string) =>
    Object.entries(TALLY_RATING_OPTIONS).find(([l]) => l.toLowerCase() === label.trim())?.[1];
  if (/^[1-5]$/.test(text)) return Number(text) as Rating;
  const labelled = /^(.+?)\s*\(([1-5])\)$/.exec(text);
  if (labelled) {
    const rating = byLabel(labelled[1]!);
    return rating === Number(labelled[2]) ? rating : undefined;
  }
  return byLabel(text);
}

/** Tally form ids are short alphanumeric strings, e.g. "wMq8xY". */
const FORM_ID = /^[A-Za-z0-9]{3,20}$/;

export type TallyFormSetting =
  | { status: 'missing' }
  | { status: 'invalid'; value: string; reason: string }
  | { status: 'ok'; formId: string };

/**
 * Parses the configured form: a share link (https://tally.so/r/<id>), an embed
 * link (https://tally.so/embed/<id>), or a bare form id. Empty means the form
 * has not been set up yet.
 */
export function parseTallyForm(value: string | undefined): TallyFormSetting {
  const text = value?.trim() ?? '';
  if (!text) return { status: 'missing' };
  if (FORM_ID.test(text)) return { status: 'ok', formId: text };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { status: 'invalid', value: text, reason: 'not a URL or a Tally form id' };
  }
  if (url.protocol !== 'https:' || url.hostname !== 'tally.so') {
    return { status: 'invalid', value: text, reason: 'expected an https://tally.so/ link' };
  }
  const match = /^\/(?:r|embed|forms)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (!match || !FORM_ID.test(match[1]!)) {
    return {
      status: 'invalid',
      value: text,
      reason: 'expected the published form link, e.g. https://tally.so/r/abc123',
    };
  }
  return { status: 'ok', formId: match[1]! };
}

export interface TallyUrls {
  /** The Tally-hosted form; also the fallback when the embed cannot load. */
  direct: string;
  /** The embeddable version used on the website's submission page. */
  embed: string;
}

/** Builds form links with the submission context as (URL-encoded) hidden-field values. */
export function tallyUrls(formId: string, context: SubmissionContext): TallyUrls {
  const params = new URLSearchParams();
  if (context.restaurantId) params.set(HIDDEN_FIELDS.restaurantId, context.restaurantId);
  if (context.restaurantNameZh)
    params.set(HIDDEN_FIELDS.restaurantNameZh, context.restaurantNameZh);
  if (context.restaurantNameEn)
    params.set(HIDDEN_FIELDS.restaurantNameEn, context.restaurantNameEn);
  params.set(HIDDEN_FIELDS.source, context.source);
  const id = encodeURIComponent(formId);
  const embedParams = new URLSearchParams({
    alignLeft: '1',
    hideTitle: '1',
    transparentBackground: '1',
  });
  for (const [key, value] of params) embedParams.set(key, value);
  return {
    direct: `https://tally.so/r/${id}?${params}`,
    embed: `https://tally.so/embed/${id}?${embedParams}`,
  };
}
