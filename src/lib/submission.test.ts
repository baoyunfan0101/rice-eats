import { describe, expect, it } from 'vitest';
import { RATINGS } from '../../shared/content/vocabulary';
import {
  contextProblem,
  isValidLatLng,
  parseKeywords,
  parseTallyForm,
  ratingFromAnswer,
  serializeKeywords,
  TALLY_RATING_OPTIONS,
  TALLY_VERDICT_OPTIONS,
  tallyUrls,
  verdictFromAnswer,
} from '../../shared/submission';
import { RATING_LABELS, VERDICT_LABELS } from './labels';

describe('Tally form setting', () => {
  it.each([
    ['https://tally.so/r/wMq8xY', 'wMq8xY'],
    ['https://tally.so/embed/wMq8xY?alignLeft=1', 'wMq8xY'],
    [' wMq8xY ', 'wMq8xY'],
  ])('accepts %s', (value, formId) => {
    expect(parseTallyForm(value)).toEqual({ status: 'ok', formId });
  });

  it('treats an empty setting as not configured', () => {
    expect(parseTallyForm('')).toEqual({ status: 'missing' });
    expect(parseTallyForm(undefined)).toEqual({ status: 'missing' });
  });

  it.each([
    'http://tally.so/r/wMq8xY',
    'https://tally.so.evil.example/r/wMq8xY',
    'https://tally.so/forms',
    'https://tally.so/r/',
    'not a form',
  ])('rejects %s', (value) => {
    expect(parseTallyForm(value).status).toBe('invalid');
  });
});

describe('Tally links', () => {
  it('passes an existing restaurant as encoded hidden fields', () => {
    const urls = tallyUrls('wMq8xY', {
      source: 'restaurant-page',
      selectionMethod: 'existing',
      restaurantId: 'r-abc234',
      restaurantName: 'Pho & Co #1',
      location: { lat: 29.7174, lng: -95.4018 },
      address: '2400 Times Blvd, Houston',
    });
    const direct = new URL(urls.direct);
    expect(direct.origin + direct.pathname).toBe('https://tally.so/r/wMq8xY');
    expect(urls.direct).toContain('restaurant_name=Pho+%26+Co+%231');
    expect(Object.fromEntries(direct.searchParams)).toEqual({
      restaurant_id: 'r-abc234',
      restaurant_name: 'Pho & Co #1',
      restaurant_lat: '29.717400',
      restaurant_lng: '-95.401800',
      restaurant_address: '2400 Times Blvd, Houston',
      selection_method: 'existing',
      source: 'restaurant-page',
    });
    const embed = new URL(urls.embed);
    expect(embed.pathname).toBe('/embed/wMq8xY');
    expect(embed.searchParams.get('restaurant_id')).toBe('r-abc234');
    expect(embed.searchParams.get('hideTitle')).toBe('1');
  });

  it('passes a POI selection with its provider and id', () => {
    const params = new URL(
      tallyUrls('wMq8xY', {
        source: 'site',
        selectionMethod: 'poi',
        restaurantName: '河粉小馆',
        location: { lat: 29.72, lng: -95.4 },
        poiProvider: 'geoapify',
        poiId: '51abc',
      }).direct,
    ).searchParams;
    expect(params.get('restaurant_id')).toBeNull();
    expect(params.get('poi_provider')).toBe('geoapify');
    expect(params.get('poi_id')).toBe('51abc');
    expect(params.get('selection_method')).toBe('poi');
  });

  it('sends only what is known for a name-only manual entry', () => {
    expect(
      tallyUrls('wMq8xY', { source: 'site', selectionMethod: 'manual', restaurantName: 'Bayou' })
        .direct,
    ).toBe('https://tally.so/r/wMq8xY?restaurant_name=Bayou&selection_method=manual&source=site');
  });

  it('passes keywords as one JSON array in tags_raw, in both links', () => {
    const keywords = ['适合约会', 'a, "b"', '很安静'];
    const urls = tallyUrls('wMq8xY', {
      source: 'site',
      selectionMethod: 'manual',
      restaurantName: 'Bayou',
      keywords,
    });
    for (const url of [urls.direct, urls.embed]) {
      const value = new URL(url).searchParams.get('tags_raw')!;
      expect(JSON.parse(value)).toEqual(keywords);
      expect(parseKeywords(value)).toEqual(keywords);
    }
    const none = tallyUrls('wMq8xY', {
      source: 'site',
      selectionMethod: 'manual',
      restaurantName: 'B',
      keywords: [],
    });
    expect(new URL(none.direct).searchParams.has('tags_raw')).toBe(false);
  });
});

describe('keywords (tags_raw)', () => {
  it('serializes cleaned keywords, or nothing', () => {
    expect(serializeKeywords([' 适合  约会 ', ''])).toBe('["适合 约会"]');
    expect(serializeKeywords([])).toBe('');
    expect(serializeKeywords(undefined)).toBe('');
  });

  it.each([
    ['', []],
    [undefined, []],
    ['["适合约会","很安静"]', ['适合约会', '很安静']],
    ['适合约会, 很安静，份量大、 适合约会\n安静', ['适合约会', '很安静', '份量大', '安静']],
    ['["Quiet","quiet","ＱＵＩＥＴ"]', ['Quiet']],
    ['[1, "x", null]', ['x']],
    ['[not json', ['[not json']],
  ])('reads %j', (value, expected) => {
    expect(parseKeywords(value)).toEqual(expected);
  });
});

describe('submission context', () => {
  it('accepts complete contexts', () => {
    expect(
      contextProblem({ source: 'site', selectionMethod: 'manual', restaurantName: 'Bayou' }),
    ).toBeUndefined();
    expect(
      contextProblem({
        source: 'restaurant-page',
        selectionMethod: 'existing',
        restaurantId: 'r-1',
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ source: 'site', selectionMethod: 'existing' }, 'restaurant id'],
    [{ source: 'site', selectionMethod: 'poi', restaurantName: ' ' }, 'name is required'],
    [
      {
        source: 'site',
        selectionMethod: 'manual',
        restaurantName: 'X',
        location: { lat: 95, lng: 0 },
      },
      'invalid coordinates',
    ],
  ] as const)('reports %j', (context, problem) => {
    expect(contextProblem(context)).toContain(problem);
  });

  it.each([
    [{ lat: 29.7, lng: -95.4 }, true],
    [{ lat: -90, lng: 180 }, true],
    [{ lat: 91, lng: 0 }, false],
    [{ lat: 0, lng: -181 }, false],
    [{ lat: NaN, lng: 0 }, false],
    [undefined, false],
  ])('validates coordinates %j', (value, valid) => {
    expect(isValidLatLng(value)).toBe(valid);
  });
});

describe('dish verdict answers', () => {
  it.each([
    ['🔥 推荐', 1],
    ['💣 避雷', -1],
    ['推荐', 1],
    [' 避雷 ', -1],
    ['不评价', undefined],
    ['', undefined],
    [undefined, undefined],
    ['还行', undefined],
  ])('maps %j to %j', (answer, verdict) => {
    expect(verdictFromAnswer(answer)).toBe(verdict);
  });
});

describe('rating answers', () => {
  it('uses the same five labels as the website', () => {
    for (const rating of RATINGS) {
      expect(TALLY_RATING_OPTIONS[RATING_LABELS[rating]]).toBe(rating);
    }
    expect(Object.keys(TALLY_VERDICT_OPTIONS)).toEqual([VERDICT_LABELS[1], VERDICT_LABELS[-1]]);
  });

  it.each([
    ['🥵 夯', 5],
    ['🫤 NPC', 2],
    ['夯', 5],
    ['npc', 2],
    [' 拉完了 ', 1],
    ['人上人 (3)', 3],
    ['顶级（4）', 4],
    ['4', 4],
  ])('maps %s to %s', (answer, rating) => {
    expect(ratingFromAnswer(answer)).toBe(rating);
  });

  it.each([undefined, '', '  ', '8/10', '还不错', '夯 (1)', '0'])(
    'never turns %j into a rating',
    (answer) => {
      expect(ratingFromAnswer(answer)).toBeUndefined();
    },
  );
});
