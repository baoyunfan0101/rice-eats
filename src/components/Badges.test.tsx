// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RATINGS } from '../../shared/content/vocabulary';
import { RATING_HINT, RATING_LABELS } from '../lib/format';
import { VERDICT_LABELS } from '../lib/labels';
import { RatingBadge, Tags, VerdictBadge } from './Badges';

const original = { ...RATING_LABELS };
afterEach(() => Object.assign(RATING_LABELS, original));

describe('RatingBadge', () => {
  it.each([
    [5, '🥵 夯'],
    [4, '😘 顶级'],
    [3, '🤤 人上人'],
    [2, '🫤 NPC'],
    [1, '🤮 拉完了'],
  ] as const)('renders rating %i as "%s"', (rating, label) => {
    render(<RatingBadge rating={rating} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('renders nothing for unrated restaurants', () => {
    const { container } = render(<RatingBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('takes labels from the central mapping, so wording changes need no data changes', () => {
    RATING_LABELS[2] = '普通';
    render(<RatingBadge rating={2} />);
    expect(screen.getByText('普通')).toBeInTheDocument();
  });

  it('lists all five levels from highest to lowest in the hint', () => {
    expect(RATINGS).toEqual([5, 4, 3, 2, 1]);
    expect(RATING_HINT).toBe(
      '个人评级，从高到低：🥵 夯 > 😘 顶级 > 🤤 人上人 > 🫤 NPC > 🤮 拉完了',
    );
  });
});

describe('VerdictBadge', () => {
  it('labels 1 as 推荐 and -1 as 避雷', () => {
    render(
      <>
        <VerdictBadge verdict={1} />
        <VerdictBadge verdict={-1} />
      </>,
    );
    expect(screen.getByText(/推荐/)).toBeInTheDocument();
    expect(screen.getByText(/避雷/)).toBeInTheDocument();
  });

  it('shows nothing when there is no verdict (no opinion is not a recommendation)', () => {
    const { container } = render(<VerdictBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('takes labels from the central mapping', () => {
    const before = VERDICT_LABELS[-1];
    VERDICT_LABELS[-1] = '不推荐';
    render(<VerdictBadge verdict={-1} />);
    expect(screen.getByText(/不推荐/)).toBeInTheDocument();
    VERDICT_LABELS[-1] = before;
  });
});

describe('Tags', () => {
  it('shows display labels for tag keys', () => {
    render(<Tags tags={['date', 'group', 'unknown-tag']} />);
    expect(screen.getByText('适合约会')).toBeInTheDocument();
    expect(screen.getByText('适合聚餐')).toBeInTheDocument();
    expect(screen.getByText('unknown-tag')).toBeInTheDocument();
  });
});
