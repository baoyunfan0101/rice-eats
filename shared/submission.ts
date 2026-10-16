// The contract between the website, the Tally submission form, and local
// intake (docs/submissions.md): the published form setting, the hidden-field
// names the website fills in, and the answer values intake understands.
// Everything here is public; the form URL is not a secret.

import type { Rating, Verdict } from './content/vocabulary';

/**
 * Hidden fields configured in the Tally form, filled in from the URL by the
 * website after a restaurant has been selected and confirmed. All of them are
 * untrusted at intake: they come from a URL anyone can edit.
 */
export const HIDDEN_FIELDS = {
  restaurantId: 'restaurant_id',
  restaurantName: 'restaurant_name',
  lat: 'restaurant_lat',
  lng: 'restaurant_lng',
  address: 'restaurant_address',
  poiProvider: 'poi_provider',
  poiId: 'poi_id',
  selectionMethod: 'selection_method',
  source: 'source',
  /** The contributor's own keywords, as a JSON array of strings (see serializeKeywords). */
  keywords: 'tags_raw',
} as const;

/** Where a submission was started; sent as the `source` hidden field. */
export const SUBMISSION_SOURCES = ['site', 'restaurant-page'] as const;
export type SubmissionSource = (typeof SUBMISSION_SOURCES)[number];

/**
 * How the restaurant was chosen: an existing Rice Eats restaurant, a place
 * found through the POI service, or a manual entry (name, and a map marker
 * when the contributor placed one).
 */
export const SELECTION_METHODS = ['existing', 'poi', 'manual'] as const;
export type SelectionMethod = (typeof SELECTION_METHODS)[number];

export interface LatLngValue {
  lat: number;
  lng: number;
}

/** The confirmed restaurant passed to the form. Only an explicitly selected location is included. */
export interface SubmissionContext {
  source: SubmissionSource;
  selectionMethod: SelectionMethod;
  restaurantId?: string;
  restaurantName?: string;
  location?: LatLngValue;
  address?: string;
  poiProvider?: string;
  poiId?: string;
  /** Free-form keywords the contributor typed (not tag ids); sent as tags_raw. */
  keywords?: string[];
}

/**
 * Limits of the keyword input. Keywords are free text (not chosen from a
 * list); intake maps them to the tag registry.
 */
export const KEYWORD_LIMITS = { count: 10, length: 20 } as const;

/** Trims and collapses spaces; the text is otherwise kept exactly as typed. */
export const cleanKeyword = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Key for "the same keyword": width, case, and spacing do not make a keyword new. */
export const keywordKey = (text: string) => cleanKeyword(text.normalize('NFKC')).toLowerCase();

/**
 * Serializes keywords for the tags_raw hidden field: a JSON array, so commas,
 * quotes, spaces, and any language survive the URL and Tally's CSV export.
 * Empty when there are none (the field is then left out).
 */
export function serializeKeywords(keywords: readonly string[] | undefined): string {
  const list = (keywords ?? []).map(cleanKeyword).filter(Boolean);
  return list.length > 0 ? JSON.stringify(list) : '';
}

/**
 * Reads a tags_raw value back into keywords. Accepts the JSON array the
 * website writes and, for hand transcriptions, a list separated by commas,
 * "，", "、", or new lines. Missing or empty (older submissions) gives [].
 * Never throws; duplicates are dropped, and order is kept.
 */
export function parseKeywords(value: string | undefined): string[] {
  const text = value?.trim();
  if (!text) return [];
  let items: unknown[] | undefined;
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      // Not JSON after all: read it as a list below.
    }
  }
  const list = (items ?? text.split(/[,，、\n]/)).filter((v): v is string => typeof v === 'string');
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list.map(cleanKeyword)) {
    if (!item || seen.has(keywordKey(item))) continue;
    seen.add(keywordKey(item));
    result.push(item);
  }
  return result;
}

/** True for coordinates that are finite and in range. */
export function isValidLatLng(value: Partial<LatLngValue> | undefined): value is LatLngValue {
  return (
    !!value &&
    typeof value.lat === 'number' &&
    typeof value.lng === 'number' &&
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lng) &&
    Math.abs(value.lat) <= 90 &&
    Math.abs(value.lng) <= 180
  );
}

/** Why a context cannot be sent to the form, or undefined when it is complete. */
export function contextProblem(context: SubmissionContext): string | undefined {
  if (context.selectionMethod === 'existing' && !context.restaurantId) {
    return 'an existing restaurant needs its restaurant id';
  }
  if (context.selectionMethod !== 'existing' && !context.restaurantName?.trim()) {
    return 'a restaurant name is required';
  }
  if (context.location && !isValidLatLng(context.location)) return 'invalid coordinates';
  return undefined;
}

/**
 * Question titles in the Tally form (docs/submissions.md). Intake finds the
 * answers in a Tally CSV export by these titles (a column whose header starts
 * with the title or one of its English aliases), so keep them when editing the form.
 */
export const TALLY_QUESTIONS = {
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
export const TALLY_DISH_GROUPS = 10;
export const TALLY_DISH_QUESTIONS = {
  name: '名称',
  verdict: '评价',
  photos: '照片',
  comment: '点评',
} as const;
export const dishQuestion = (group: number, part: keyof typeof TALLY_DISH_QUESTIONS) =>
  `菜品${group} ${TALLY_DISH_QUESTIONS[part]}`;

/**
 * Drops emoji (and the variation selectors and joiners that go with them)
 * so answers match with or without the emoji shown in the form.
 */
const withoutEmoji = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .trim();

/** Options of a dish's required "评价" question (same labels as the website). */
export const TALLY_VERDICT_OPTIONS: Record<string, Verdict> = {
  '🔥 推荐': 1,
  '💣 避雷': -1,
};

/** Maps a dish verdict answer to the stored verdict; undefined unless clearly 推荐 or 避雷. */
export function verdictFromAnswer(answer: string | undefined): Verdict | undefined {
  const text = answer && withoutEmoji(answer);
  if (!text) return undefined;
  return Object.entries(TALLY_VERDICT_OPTIONS).find(([label]) => withoutEmoji(label) === text)?.[1];
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
  '🥵 夯': 5,
  '😘 顶级': 4,
  '🤤 人上人': 3,
  '🫤 NPC': 2,
  '🤮 拉完了': 1,
};

/**
 * Maps a submitted rating answer to the stored rating. Accepts an option label
 * ("夯", any case), its number ("5"), or both ("夯 (5)"). Returns undefined
 * when the question was left unanswered or the answer is not recognized, so
 * an unselected rating never becomes a rating.
 */
export function ratingFromAnswer(answer: string | undefined): Rating | undefined {
  const text = answer && withoutEmoji(answer).toLowerCase();
  if (!text) return undefined;
  const byLabel = (label: string) =>
    Object.entries(TALLY_RATING_OPTIONS).find(
      ([l]) => withoutEmoji(l).toLowerCase() === label.trim(),
    )?.[1];
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
  const set = (key: string, value: string | undefined) => {
    if (value?.trim()) params.set(key, value.trim());
  };
  set(HIDDEN_FIELDS.restaurantId, context.restaurantId);
  set(HIDDEN_FIELDS.restaurantName, context.restaurantName);
  if (context.location && isValidLatLng(context.location)) {
    // About 10 cm of precision is plenty for a restaurant.
    set(HIDDEN_FIELDS.lat, context.location.lat.toFixed(6));
    set(HIDDEN_FIELDS.lng, context.location.lng.toFixed(6));
  }
  set(HIDDEN_FIELDS.address, context.address);
  set(HIDDEN_FIELDS.poiProvider, context.poiProvider);
  set(HIDDEN_FIELDS.poiId, context.poiId);
  set(HIDDEN_FIELDS.selectionMethod, context.selectionMethod);
  set(HIDDEN_FIELDS.source, context.source);
  set(HIDDEN_FIELDS.keywords, serializeKeywords(context.keywords));
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
