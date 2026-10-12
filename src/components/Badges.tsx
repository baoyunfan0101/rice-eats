import type { Rating, Verdict } from '../../shared/content/model';
import { tagLabel, VERDICT_LABELS } from '../lib/labels';
import { RATING_HINT, RATING_LABELS, RATING_STYLES } from '../lib/format';

export function RatingBadge({ rating, size = 'sm' }: { rating?: Rating; size?: 'sm' | 'lg' }) {
  if (rating === undefined) return null;
  return (
    <span
      title={RATING_HINT}
      className={`inline-flex shrink-0 items-center rounded-full font-bold ${RATING_STYLES[rating]} ${
        size === 'lg' ? 'px-3 py-1 text-base' : 'px-2 py-0.5 text-xs'
      }`}
    >
      <span className="sr-only">评级：</span>
      {RATING_LABELS[rating]}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict?: Verdict }) {
  if (verdict === undefined) return null;
  const good = verdict === 1;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
        good ? 'bg-basil-50 text-basil-600' : 'bg-stone-200 text-stone-600'
      }`}
    >
      {good ? '👍 ' : '⚠️ '}
      {VERDICT_LABELS[verdict]}
    </span>
  );
}

export function DraftBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-dashed border-amber-500 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">
      草稿预览
    </span>
  );
}

export function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="标签">
      {tags.map((tag) => (
        <li key={tag} className="rounded-md bg-line/70 px-2 py-0.5 text-xs text-muted">
          {tagLabel(tag)}
        </li>
      ))}
    </ul>
  );
}
