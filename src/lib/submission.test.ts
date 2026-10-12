import { describe, expect, it } from 'vitest';
import { RATINGS } from '../../shared/content/vocabulary';
import {
  parseTallyForm,
  ratingFromAnswer,
  TALLY_RATING_OPTIONS,
  tallyUrls,
} from '../../shared/submission';
import { RATING_LABELS } from './labels';

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
  it('passes restaurant context as encoded hidden fields', () => {
    const urls = tallyUrls('wMq8xY', {
      source: 'restaurant-page',
      restaurantId: 'r-abc234',
      restaurantName: 'Pho & Co #1 越南粉',
    });
    const direct = new URL(urls.direct);
    expect(direct.origin + direct.pathname).toBe('https://tally.so/r/wMq8xY');
    expect(urls.direct).toContain('restaurant_name=Pho+%26+Co+%231');
    expect(Object.fromEntries(direct.searchParams)).toEqual({
      restaurant_id: 'r-abc234',
      restaurant_name: 'Pho & Co #1 越南粉',
      source: 'restaurant-page',
    });
    const embed = new URL(urls.embed);
    expect(embed.pathname).toBe('/embed/wMq8xY');
    expect(embed.searchParams.get('restaurant_id')).toBe('r-abc234');
    expect(embed.searchParams.get('hideTitle')).toBe('1');
  });

  it('sends only the source for general submissions', () => {
    expect(tallyUrls('wMq8xY', { source: 'site' }).direct).toBe(
      'https://tally.so/r/wMq8xY?source=site',
    );
  });
});

describe('rating answers', () => {
  it('uses the same five labels as the website', () => {
    for (const rating of RATINGS) {
      expect(TALLY_RATING_OPTIONS[RATING_LABELS[rating]]).toBe(rating);
    }
  });

  it.each([
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
