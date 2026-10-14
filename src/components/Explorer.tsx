import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
import { DraftBadge, RatingBadge, Tags } from './Badges';
import { Link } from './Link';
import { PixelCheck, PixelChevron, PixelSearch } from './PixelIcons';
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
  detailHref,
  onHover,
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
  /** The link that opens a restaurant's details (beside the map, which selects it). */
  detailHref: (id: string) => string;
  /** The restaurant under the pointer ('' for none); the map highlights its pin. */
  onHover?: (id: string) => void;
  onSearchFocus?: () => void;
  footer?: ReactNode;
}) {
  const [panel, setPanel] = useState<Panel>();
  const filtered = hasActiveFilters(state);
  const sortId = useId();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* On phones the bottom sheet is dragged by this bar too (its non-control parts). */}
      <div
        data-sheet-drag
        className="shrink-0 touch-pan-x space-y-2 border-b-2 border-ink px-3 pt-1 pb-2.5"
      >
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
        <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
          <p className="text-xs font-semibold text-muted" aria-live="polite">
            {filtered ? `找到 ${results.length} 家 / 共 ${total} 家` : `共 ${total} 家`}
          </p>
          <div className="flex items-center gap-1">
            <label htmlFor={sortId} className="text-xs font-semibold text-muted">
              排序
            </label>
            <select
              id={sortId}
              value={sort}
              onChange={(e) => onSort(e.target.value as Sort)}
              className="field h-8 min-h-8 pr-7 pl-2 text-sm"
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
          <p role="status" className="px-3 pb-1 text-xs font-semibold text-chili-700">
            {locating === 'denied'
              ? '没有获得定位权限，无法按距离排序，已改回之前的排序。'
              : '暂时无法获取当前位置，无法按距离排序，已改回之前的排序。'}
          </p>
        )}

        {results.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p
              className="flex size-14 items-center justify-center border-2 border-ink bg-gold-100 text-2xl shadow-px-sm"
              aria-hidden="true"
            >
              🔍
            </p>
            <h2 className="font-black">没有符合条件的餐厅</h2>
            <p className="text-sm text-muted">换个关键词，或者放宽筛选条件试试。</p>
            <button
              type="button"
              onClick={() => onChange(clearFilters(state))}
              className="btn btn-primary btn-sm px-4"
            >
              清除全部筛选
            </button>
          </div>
        ) : (
          <ul aria-label="餐厅列表" className="space-y-1 px-2 pt-1 pb-2">
            {results.map((r) => (
              <RestaurantCard
                key={r.id}
                restaurant={r}
                selected={r.id === state.selected}
                distance={distances?.get(r.id)}
                href={detailHref(r.id)}
                onHover={onHover}
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
      <PixelSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        placeholder="搜索餐厅名称"
        enterKeyHint="search"
        className="field h-10 min-h-10 w-full pr-3 pl-9 text-base"
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
    <div
      className="-mx-3 flex items-center gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]"
      role="group"
      aria-label="筛选"
    >
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
            className="chip group h-8 shrink-0 gap-1"
          >
            {text}
            <PixelChevron className="size-2.5 rotate-90 group-aria-expanded:-rotate-90" />
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
          className="text-action h-8 shrink-0 px-1 text-[13px]"
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
    <section id="filter-panel" aria-label={PANEL_TITLES[panel]} className="card mx-3 mt-2.5">
      <div className="window-bar py-1.5 pr-1.5 pl-3">
        <h2 className="flex-1 text-xs font-black">{PANEL_TITLES[panel]}</h2>
        {active && (
          <button
            type="button"
            onClick={() => onChange(reset)}
            className="h-7 px-2 text-xs font-bold underline decoration-2 underline-offset-2 hover:text-chili-700"
          >
            重置
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="btn btn-dark btn-sm min-h-7 px-3 text-xs"
        >
          完成
        </button>
      </div>
      <div className="p-3">{body}</div>
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
  if (options.length === 0) return <p className="text-xs text-muted">暂无可选项。</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([value, text]) => (
        <button
          key={value}
          type="button"
          aria-pressed={selected.includes(value)}
          onClick={() => onToggle(value)}
          className="chip"
        >
          {selected.includes(value) && <PixelCheck className="size-3" />}
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * The price range: a two-handle slider from $0 to $100+ (the top end means no
 * upper limit, so a higher price is never excluded by the slider). Each
 * handle carries its value; the handles cannot cross, so the range is always
 * valid.
 */
function PriceRange({ state, onChange }: { state: BrowseState; onChange: Change }) {
  const low = Math.min(state.priceMin ?? 0, PRICE_SLIDER_MAX);
  const high =
    state.priceMax === undefined ? PRICE_SLIDER_MAX : Math.min(state.priceMax, PRICE_SLIDER_MAX);
  // The tags show the actual values, also beyond the slider's end (from a link).
  const lowText = `$${state.priceMin ?? 0}`;
  const highText = state.priceMax === undefined ? `$${PRICE_SLIDER_MAX}+` : `$${state.priceMax}`;
  // Thumb centers (the thumbs are 20px wide): keeps the value tags on their thumbs.
  const at = (v: number) =>
    `calc(${(v / PRICE_SLIDER_MAX) * 100}% + ${10 - (v / PRICE_SLIDER_MAX) * 20}px)`;
  // Near either end, a tag aligns with that end instead of overflowing it.
  const tagAt = (v: number): CSSProperties =>
    v < PRICE_SLIDER_MAX * 0.15
      ? { left: 0 }
      : v > PRICE_SLIDER_MAX * 0.85
        ? { right: 0 }
        : { left: at(v), transform: 'translateX(-50%)' };
  // Close values share one tag, so the tags never overlap.
  const close = high - low < PRICE_SLIDER_MAX * 0.2;
  const together =
    state.priceMax !== undefined && (state.priceMin ?? 0) === state.priceMax
      ? lowText
      : state.priceMax === undefined && low >= PRICE_SLIDER_MAX
        ? `${lowText}+`
        : `${lowText}–${highText.slice(1)}`;
  const tag =
    'absolute top-0 bg-ink px-1.5 font-pixel text-xs leading-5 whitespace-nowrap text-cream';
  return (
    <div className="relative h-12">
      {close ? (
        <span aria-hidden="true" className={tag} style={tagAt((low + high) / 2)}>
          {together}
        </span>
      ) : (
        <>
          <span aria-hidden="true" className={tag} style={tagAt(low)}>
            {lowText}
          </span>
          <span aria-hidden="true" className={tag} style={tagAt(high)}>
            {highText}
          </span>
        </>
      )}
      <div className="absolute right-2.5 bottom-[7px] left-2.5 h-2 border-2 border-ink bg-sand" />
      <div
        className="absolute bottom-[7px] h-2 border-y-2 border-ink bg-chili-500"
        style={{ left: at(low), right: `calc(100% - ${at(high)})` }}
      />
      <input
        type="range"
        aria-label="最低人均"
        aria-valuetext={lowText}
        // When the handles meet at the top end, the lower one must stay reachable.
        style={low >= high && low > 0 ? { zIndex: 1 } : undefined}
        min={0}
        max={PRICE_SLIDER_MAX}
        step={PRICE_STEP}
        value={low}
        onChange={(e) => {
          const value = Math.min(Number(e.target.value), high);
          onChange({ priceMin: value > 0 ? value : undefined }, { replace: true });
        }}
        className="price-thumb absolute inset-x-0 bottom-0 h-[22px] w-full"
      />
      <input
        type="range"
        aria-label="最高人均"
        aria-valuetext={state.priceMax === undefined ? '不限' : highText}
        min={0}
        max={PRICE_SLIDER_MAX}
        step={PRICE_STEP}
        value={high}
        onChange={(e) => {
          const value = Math.max(Number(e.target.value), low);
          onChange({ priceMax: value >= PRICE_SLIDER_MAX ? undefined : value }, { replace: true });
        }}
        className="price-thumb absolute inset-x-0 bottom-0 h-[22px] w-full"
      />
    </div>
  );
}

function RestaurantCard({
  restaurant: r,
  selected,
  distance,
  href,
  onHover,
}: {
  restaurant: RestaurantSummary;
  selected: boolean;
  distance?: number;
  href: string;
  onHover?: (id: string) => void;
}) {
  return (
    <li
      data-selected={selected ? '' : undefined}
      onPointerEnter={(e) => e.pointerType === 'mouse' && onHover?.(r.id)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && onHover?.('')}
      className="relative flex gap-2.5 border-2 border-transparent px-1.5 py-2 hover:border-ink hover:bg-cream data-selected:border-ink data-selected:bg-gold-100 data-selected:shadow-px"
    >
      <RestaurantImage
        decorative
        image={r.cover}
        sizes="64px"
        className="aspect-square w-16 shrink-0 border-2 border-ink"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="leading-snug font-black">
            {/* The card links to the details page; the link covers the card. */}
            <Link
              href={href}
              onFocus={() => onHover?.(r.id)}
              onBlur={() => onHover?.('')}
              className="after:absolute after:inset-0 hover:text-chili-700"
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
    </li>
  );
}
