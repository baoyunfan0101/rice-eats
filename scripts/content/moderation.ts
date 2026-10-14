// Editorial review hints for submissions: patterns a reviewer should look at
// before drafting (promotion, a possibly undisclosed relationship with the
// restaurant, strong accusations, and repeated or near-identical reviews).
// They are notes for a human, never automatic rejections: the consent
// statement asks contributors for honest, first-hand, undisclosed-interest-free
// reviews, and these hints help check that.

export interface ReviewText {
  submissionId: string;
  restaurant?: string;
  email?: string;
  text: string;
}

/** Promotion: deals, calls to action, contact or ordering details. */
const PROMOTION = [
  /优惠|折扣|打折|促销|团购|优惠码|折扣码|限时|买一送一|满减/,
  /欢迎(大家|各位)?(光临|前来|来店)|关注(我们|公众号)|公众号|微信|加\s*v|vx/i,
  /\b(coupon|promo(tion)? code|discount|deal of|order now|follow us|dm us|book now)\b/i,
  /https?:\/\/|www\./i,
  /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
];
/** First-person ties to the restaurant, or free or sponsored meals. */
const RELATIONSHIP = [
  /本店|我(们)?(家|店)(的|新)|我是(这家店的)?(老板|店主|员工|服务员|厨师)|老板(是我|的朋友)/,
  /合作|赞助|受邀|免费(品尝|赠送|招待|提供)|店家(请客|招待)/,
  /\b(sponsored|comped|complimentary meal|i work (at|there|here)|my restaurant|our restaurant|i('m| am) the owner)\b/i,
];
/** Strong accusations that need support from the described experience. */
const ACCUSATION = [
  /骗子|黑店|诈骗|下毒|食物中毒|垃圾店|无良|坑人/,
  /\b(scam|scammers?|fraud|food poisoning|poisoned|rip-?off)\b/i,
];

/** Similarity of two texts (0 to 1): Jaccard index of character bigrams, ignoring spacing and punctuation. */
export function similarity(a: string, b: string): number {
  const grams = (text: string) => {
    const clean = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const set = new Set<string>();
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  };
  const x = grams(a);
  const y = grams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Texts at least this similar count as near-identical. */
export const SIMILAR = 0.8;
/** Shorter texts ("好吃！") are too common to compare. */
const MIN_COMPARE_LENGTH = 20;

/**
 * Review hints for one submission's text, compared with other submissions
 * (earlier imports and the rest of the export).
 */
export function reviewHints(current: ReviewText, others: ReviewText[]): string[] {
  const hints: string[] = [];
  const text = current.text;
  if (text.trim()) {
    if (PROMOTION.some((re) => re.test(text))) {
      hints.push(
        'review check: the text reads like promotion (deals, calls to action, links, or contact details); ' +
          'make sure it is a first-hand experience and remove promotional content',
      );
    }
    if (RELATIONSHIP.some((re) => re.test(text))) {
      hints.push(
        'review check: the text suggests a relationship with the restaurant (owner, staff, sponsorship, ' +
          'or a free meal); ask the contributor to disclose it, or reject',
      );
    }
    if (ACCUSATION.some((re) => re.test(text))) {
      hints.push(
        'review check: strong accusations (fraud, poisoning, and the like); keep only what the described ' +
          'experience supports, or reject',
      );
    }
  }
  const comparable = text.replace(/\s+/g, '').length >= MIN_COMPARE_LENGTH;
  for (const other of others) {
    if (other.submissionId === current.submissionId) continue;
    if (comparable && other.text.replace(/\s+/g, '').length >= MIN_COMPARE_LENGTH) {
      if (similarity(text, other.text) >= SIMILAR) {
        hints.push(
          `review check: the text is nearly identical to submission ${other.submissionId}; ` +
            'check for duplicate or coordinated reviews',
        );
        continue;
      }
    }
    if (
      current.email &&
      other.email?.toLowerCase() === current.email.toLowerCase() &&
      current.restaurant &&
      other.restaurant?.toLowerCase() === current.restaurant.toLowerCase()
    ) {
      hints.push(
        `review check: the same contact email already reviewed this restaurant (submission ${other.submissionId}); ` +
          'treat repeated reviews as one contributor',
      );
    }
  }
  return hints;
}
