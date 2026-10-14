import { describe, expect, it } from 'vitest';
import { reviewHints, similarity } from '../../scripts/content/moderation.ts';

const text = (submissionId: string, t: string, extra = {}) => ({ submissionId, text: t, ...extra });

describe('review hints', () => {
  it('measures similarity ignoring spacing and punctuation', () => {
    expect(similarity('汤头浓郁，面条筋道！', '汤头浓郁 面条筋道')).toBe(1);
    expect(similarity('汤头浓郁，面条筋道', '服务很慢，环境一般')).toBeLessThan(0.2);
    expect(similarity('', 'x')).toBe(0);
  });

  it('flags strong accusations and contact details, not ordinary criticism', () => {
    expect(reviewHints(text('a', '这就是黑店，吃完食物中毒了'), []).join()).toMatch(
      /strong accusations/,
    );
    expect(reviewHints(text('b', 'Call 713-555-0100 to book now!'), []).join()).toMatch(
      /promotion/,
    );
    expect(reviewHints(text('c', '面有点咸，服务也慢，不太推荐。'), [])).toEqual([]);
  });

  it('does not compare short texts, and notes repeat reviews by the same email', () => {
    expect(reviewHints(text('a', '好吃！'), [text('b', '好吃！')])).toEqual([]);
    const hints = reviewHints(
      text('a', '第二次来，还是很好吃', { email: 'X@example.com', restaurant: 'r1' }),
      [text('b', '完全不同的一段文字内容', { email: 'x@example.com', restaurant: 'R1' })],
    );
    expect(hints.join()).toMatch(/same contact email already reviewed this restaurant/);
  });
});
