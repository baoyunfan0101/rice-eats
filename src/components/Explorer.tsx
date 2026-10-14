import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { RestaurantSummary } from '../../shared/content/model';
import type { Rating } from '../../shared/content/vocabulary';
import {
  clearFilters,
  hasActiveFilters,
  hasPriceRange,
  toggle,
  type BrowseState,
  type Sort,
} from '../lib/filters';
import { metaLine } from '../lib/format';
import { cuisineLabel, RATING_LABELS, tagLabel } from '../lib/labels';
import { distanceText } from '../lib/poi';
import { PRICE_SLIDER_MAX, PRICE_STEP, priceRangeLabel } from '../lib/price';
import { restaurantHref } from '../lib/router';
import { DraftBadge, RatingBadge, Tags } from './Badges';
import { Link } from './Link';
import { RestaurantImage } from './RestaurantImage';

export type Change = (next: Partial<BrowseState>, options?: { replace?: boolean }) => void;

/** Where the visitor's location stands for distance sorting (never stored or shared). */
export type Locating = 'idle' | 'locating' | 'denied' | 'unavailable';

const SORT_LABELS: Record<Sort, string> = {
  rating: '按评级（从高到低）',
  distance: '按距离（从近到远）',
  'price-asc': '按人均（从低到高）',
  'price-desc': '按人均（从高到低）',
  name: '按名称',
};

type Panel = 'cuisine' | 'tag' | 'rating' | 'price';

/**
 * A, the restaurant explorer: search, filters (multi-select within cuisine,
 * tag, and rating, plus a price range), the result count with the sort, and
 * the list. It decides which restaurants the map shows; the map never
 * changes it.
 */
export function Explorer({
  state,
  total,
  results,
  facets,
  sort,
  locating,
  distances,
  onChange,
  onSort,
  onLocate,
  onSearchFocus,
  footer,
}: {
  state: BrowseState;
  total: number;
  /** The filtered restaurants, sorted. */
  results: RestaurantSummary[];
  facets: { cuisines: string[]; tags: string[]; ratings: Rating[] };
  /** The sort in effect (distance is not part of the URL state). */
  sort: Sort;
  locating: Locating;
  /** Distance in meters from the visitor, by restaurant id, once known. */
  distances?: Map<string, number>;
  onChange: Change;
  onSort: (sort: Sort) => void;
  /** Shows a restaurant on the map. */
  onLocate: (id: string) => void;
  onSearchFocus?: () => void;
  footer?: ReactNode;
}) {
  const [panel, setPanel] = useState<Panel>();
  const filtered = hasActiveFilters(state);
  const sortId = useId();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-line px-4 pt-1 pb-3">
        <SearchBox
          value={state.query}
          onChange={(query) => onChange({ query }, { replace: true })}
          onFocus={onSearchFocus}
        />
        <FilterButtons state={state} panel={panel} onPanel={setPanel} onChange={onChange} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {panel && (
          <FilterPanel
            panel={panel}
            state={state}
            facets={facets}
            onChange={onChange}
            onClose={() => setPanel(undefined)}
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-1">
          <p className="text-sm text-muted" aria-live="polite">
            {filtered ? `找到 ${results.length} 家 / 共 ${total} 家` : `共 ${total} 家`}
          </p>
          <div className="flex items-center gap-1">
            <label htmlFor={sortId} className="text-sm text-muted">
              排序
            </label>
            <select
              id={sortId}
              value={sort}
              onChange={(e) => onSort(e.target.value as Sort)}
              className="h-9 rounded-full border border-line bg-white pr-8 pl-3 text-sm hover:border-chili-600"
            >
              {(Object.keys(SORT_LABELS) as Sort[]).map((s) => (
                <option key={s} value={s}>
                  {s === 'distance' && locating === 'locating' ? '正在获取位置…' : SORT_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {(locating === 'denied' || locating === 'unavailable') && (
          <p role="status" className="px-4 pb-1 text-sm text-chili-700">
            {locating === 'denied'
              ? '没有获得定位权限，无法按距离排序，已改回之前的排序。'
              : '暂时无法获取当前位置，无法按距离排序，已改回之前的排序。'}
          </p>
        )}

        {results.length === 0 ? (
          <div className="space-y-3 px-4 py-10 text-center">
            <p className="text-3xl" aria-hidden="true">
              🔍
            </p>
            <h2 className="font-bold">没有符合条件的餐厅</h2>
            <p className="text-sm text-muted">换个关键词，或者放宽筛选条件试试。</p>
            <button
              type="button"
              onClick={() => onChange(clearFilters(state))}
              className="rounded-full bg-chili-600 px-4 py-2 text-sm font-semibold text-white hover:bg-chili-700"
            >
              清除全部筛选
            </button>
          </div>
        ) : (
          <ul aria-label="餐厅列表" className="divide-y divide-line px-2 pb-2">
            {results.map((r) => (
              <RestaurantCard
                key={r.id}
                restaurant={r}
                selected={r.id === state.selected}
                distance={distances?.get(r.id)}
                onLocate={onLocate}
              />
            ))}
          </ul>
        )}
        {footer}
      </div>
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  onFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
}) {
  return (
    <label className="relative block">
      <span className="sr-only">搜索餐厅名称</span>
      <svg
        viewBox="0 0 20 20"
        className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
        aria-hidden="true"
      >
        <path
          d="M9 3a6 6 0 1 0 3.9 10.6l3.3 3.2 1.1-1.1-3.2-3.3A6 6 0 0 0 9 3Zm0 1.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z"
          fill="currentColor"
        />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        placeholder="搜索餐厅名称"
        enterKeyHint="search"
        className="h-11 w-full rounded-full border border-line bg-white pr-4 pl-10 text-base placeholder:text-muted/80 hover:border-chili-600"
      />
    </label>
  );
}

function FilterButtons({
  state,
  panel,
  onPanel,
  onChange,
}: {
  state: BrowseState;
  panel?: Panel;
  onPanel: (panel?: Panel) => void;
  onChange: Change;
}) {
  const price = priceRangeLabel(state.priceMin, state.priceMax);
  const buttons: [Panel, string, number | string][] = [
    ['cuisine', '菜系', state.cuisines.length],
    ['tag', '标签', state.tags.length],
    ['rating', '评级', state.ratings.length],
    ['price', '人均', price],
  ];
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="筛选">
      {buttons.map(([id, label, value]) => {
        const active = typeof value === 'number' ? value > 0 : value !== '';
        const text = id === 'price' && active ? value : active ? `${label} (${value})` : label;
        return (
          <button
            key={id}
            type="button"
            aria-expanded={panel === id}
            aria-controls="filter-panel"
            data-active={active ? '' : undefined}
            onClick={() => onPanel(panel === id ? undefined : id)}
            className="inline-flex h-9 items-center gap-1 rounded-full border border-line bg-white px-3 text-sm font-semibold hover:border-chili-600 aria-expanded:border-ink data-active:border-chili-600 data-active:bg-chili-50 data-active:text-chili-700"
          >
            {text}
            <span aria-hidden="true" className="text-xs">
              ▾
            </span>
          </button>
        );
      })}
      {hasActiveFilters(state) && (
        <button
          type="button"
          onClick={() => {
            onPanel(undefined);
            onChange(clearFilters(state));
          }}
          className="h-9 rounded-full px-2 text-sm font-semibold text-chili-700 hover:bg-chili-50"
        >
          清除全部
        </button>
      )}
    </div>
  );
}

const PANEL_TITLES: Record<Panel, string> = {
  cuisine: '菜系（可多选）',
  tag: '标签（可多选）',
  rating: '评级（可多选）',
  price: '人均价格（美元）',
};

function FilterPanel({
  panel,
  state,
  facets,
  onChange: change,
  onClose,
}: {
  panel: Panel;
  state: BrowseState;
  facets: { cuisines: string[]; tags: string[]; ratings: Rating[] };
  onChange: Change;
  onClose: () => void;
}) {
  // One history entry per panel visit, however many options are toggled, so
  // "back" undoes the visit rather than each click.
  const pushed = useRef(false);
  const onChange: Change = (next, options) => {
    change(next, { replace: pushed.current || options?.replace });
    pushed.current = true;
  };
  useEffect(() => {
    pushed.current = false;
  }, [panel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keep values from a shared link selectable even if no restaurant uses them any more.
  const withSelected = <T,>(options: T[], selected: T[]) => [
    ...options,
    ...selected.filter((v) => !options.includes(v)),
  ];
  let body: ReactNode;
  let reset: Partial<BrowseState>;
  let active: boolean;
  if (panel === 'price') {
    body = <PriceRange state={state} onChange={onChange} />;
    reset = { priceMin: undefined, priceMax: undefined };
    active = hasPriceRange(state);
  } else if (panel === 'rating') {
    body = (
      <Chips
        options={withSelected(facets.ratings, state.ratings).map((r) => [r, RATING_LABELS[r]])}
        selected={state.ratings}
        onToggle={(r) => onChange({ ratings: toggle(state.ratings, r) })}
      />
    );
    reset = { ratings: [] };
    active = state.ratings.length > 0;
  } else {
    const key = panel === 'cuisine' ? 'cuisines' : 'tags';
    const label = panel === 'cuisine' ? cuisineLabel : tagLabel;
    const values = state[key];
    body = (
      <Chips
        options={withSelected(facets[key], values).map((v) => [v, label(v)])}
        selected={values}
        onToggle={(v) => onChange({ [key]: toggle(values, v) })}
      />
    );
    reset = { [key]: [] };
    active = values.length > 0;
  }
  return (
    <section
      id="filter-panel"
      aria-label={PANEL_TITLES[panel]}
      className="mx-4 mt-3 space-y-3 rounded-2xl border border-line bg-white p-4 shadow-sm"
    >
      <h2 className="text-sm font-bold">{PANEL_TITLES[panel]}</h2>
      {body}
      <div className="flex justify-end gap-2">
        {active && (
          <button
            type="button"
            onClick={() => onChange(reset)}
            className="h-9 rounded-full px-3 text-sm font-semibold text-chili-700 hover:bg-chili-50"
          >
            重置
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="h-9 rounded-full bg-ink px-4 text-sm font-semibold text-white"
        >
          完成
        </button>
      </div>
    </section>
  );
}

function Chips<T extends string | number>({
  options,
  selected,
  onToggle,
}: {
  options: [T, string][];
  selected: T[];
  onToggle: (value: T) => void;
}) {
  if (options.length === 0) return <p className="text-sm text-muted">暂无可选项。</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([value, text]) => (
        <button
          key={value}
          type="button"
          aria-pressed={selected.includes(value)}
          onClick={() => onToggle(value)}
          className="min-h-9 rounded-full border border-line px-3 text-sm hover:border-chili-600 aria-pressed:border-chili-600 aria-pressed:bg-chili-600 aria-pressed:text-white"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * The price range: a two-handle slider ($0 to $100+, where $100+ means no
 * upper limit) and two number fields that accept any amount. Both ends are
 * optional; an invalid range (minimum above maximum) is never applied.
 */
function PriceRange({ state, onChange }: { state: BrowseState; onChange: Change }) {
  const min = state.priceMin;
  const max = state.priceMax;
  const [draft, setDraft] = useState({ min: min?.toString() ?? '', max: max?.toString() ?? '' });
  // Follow changes made elsewhere (the slider, reset, a new URL).
  const [synced, setSynced] = useState({ min, max });
  if (synced.min !== min || synced.max !== max) {
    setSynced({ min, max });
    setDraft({ min: min?.toString() ?? '', max: max?.toString() ?? '' });
  }
  const parse = (text: string) => {
    if (text.trim() === '') return undefined;
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };
  const draftMin = parse(draft.min);
  const draftMax = parse(draft.max);
  const error =
    Number.isNaN(draftMin) || Number.isNaN(draftMax)
      ? '请输入有效的金额。'
      : draftMin !== undefined && draftMax !== undefined && draftMin > draftMax
        ? '最低价不能高于最高价。'
        : undefined;
  const commit = (next: { min: string; max: string }) => {
    setDraft(next);
    const a = parse(next.min);
    const b = parse(next.max);
    if (Number.isNaN(a) || Number.isNaN(b) || (a !== undefined && b !== undefined && a > b)) return;
    onChange({ priceMin: a, priceMax: b }, { replace: true });
  };

  const lowValue = Math.min(min ?? 0, PRICE_SLIDER_MAX);
  const highValue = max === undefined ? PRICE_SLIDER_MAX : Math.min(max, PRICE_SLIDER_MAX);
  const field =
    'h-10 w-full min-w-0 rounded-xl border border-line bg-white pl-6 pr-2 text-base aria-invalid:border-chili-600';
  return (
    <div className="space-y-3">
      <div className="relative h-8">
        <div className="absolute top-1/2 right-2 left-2 h-1 -translate-y-1/2 rounded bg-line" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded bg-chili-600"
          style={{
            left: `calc(${(lowValue / PRICE_SLIDER_MAX) * 100}% * 0.96 + 2%)`,
            right: `calc(${100 - (highValue / PRICE_SLIDER_MAX) * 100}% * 0.96 + 2%)`,
          }}
        />
        <input
          type="range"
          aria-label="最低人均"
          min={0}
          max={PRICE_SLIDER_MAX}
          step={PRICE_STEP}
          value={lowValue}
          onChange={(e) => {
            const value = Math.min(Number(e.target.value), highValue);
            onChange({ priceMin: value > 0 ? value : undefined }, { replace: true });
          }}
          className="price-thumb absolute inset-0 w-full"
        />
        <input
          type="range"
          aria-label="最高人均"
          aria-valuetext={highValue >= PRICE_SLIDER_MAX ? '不限' : `$${highValue}`}
          min={0}
          max={PRICE_SLIDER_MAX}
          step={PRICE_STEP}
          value={highValue}
          onChange={(e) => {
            const value = Math.max(Number(e.target.value), lowValue);
            onChange(
              { priceMax: value >= PRICE_SLIDER_MAX ? undefined : value },
              { replace: true },
            );
          }}
          className="price-thumb absolute inset-0 w-full"
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <span
            aria-hidden="true"
            className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
          >
            $
          </span>
          <input
            inputMode="decimal"
            aria-label="最低价（美元）"
            value={draft.min}
            placeholder="不限"
            aria-invalid={error ? true : undefined}
            onChange={(e) => commit({ ...draft, min: e.target.value })}
            className={field}
          />
        </div>
        <span aria-hidden="true">–</span>
        <div className="relative min-w-0 flex-1">
          <span
            aria-hidden="true"
            className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
          >
            $
          </span>
          <input
            inputMode="decimal"
            aria-label="最高价（美元）"
            value={draft.max}
            placeholder="不限"
            aria-invalid={error ? true : undefined}
            onChange={(e) => commit({ ...draft, max: e.target.value })}
            className={field}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-chili-700">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted">
          留空表示不限；滑块拉到最右是「${PRICE_SLIDER_MAX}
          +」（不设上限）。设置价格范围后，未标注人均的餐厅不会显示。
        </p>
      )}
    </div>
  );
}

function RestaurantCard({
  restaurant: r,
  selected,
  distance,
  onLocate,
}: {
  restaurant: RestaurantSummary;
  selected: boolean;
  distance?: number;
  onLocate: (id: string) => void;
}) {
  return (
    <li
      data-selected={selected ? '' : undefined}
      className="relative flex gap-3 rounded-xl px-2 py-3 hover:bg-white data-selected:bg-white data-selected:ring-2 data-selected:ring-chili-600"
    >
      <RestaurantImage
        decorative
        image={r.cover}
        sizes="80px"
        className="aspect-square w-20 shrink-0 rounded-lg"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="leading-snug font-bold">
            {/* The card links to the details page; the link covers the card. */}
            <Link
              href={restaurantHref(r.id)}
              className="after:absolute after:inset-0 after:rounded-xl hover:text-chili-700"
            >
              {r.name}
            </Link>
          </h2>
          <RatingBadge rating={r.rating} />
          {r.status === 'draft' && <DraftBadge />}
        </div>
        {r.altNames.length > 0 && (
          <p className="truncate text-xs text-muted">{r.altNames.join(' / ')}</p>
        )}
        <p className="text-sm text-ink/80">
          {[metaLine(r), distance !== undefined && distanceText(distance)]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <Tags tags={r.tags.slice(0, 3)} />
      </div>
      {r.location && (
        <button
          type="button"
          onClick={() => onLocate(r.id)}
          aria-label={`在地图上显示${r.name}`}
          title="在地图上显示"
          className="relative z-10 flex size-10 shrink-0 items-center justify-center self-center rounded-full border border-line bg-white text-chili-700 hover:border-chili-600"
        >
          <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
            <path
              d="M10 2a6 6 0 0 0-6 6c0 4.5 6 10 6 10s6-5.5 6-10a6 6 0 0 0-6-6Zm0 8.2A2.2 2.2 0 1 1 10 5.8a2.2 2.2 0 0 1 0 4.4Z"
              fill="currentColor"
            />
          </svg>
        </button>
      )}
    </li>
  );
}
