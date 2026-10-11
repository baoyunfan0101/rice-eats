import { PRICE_BUCKETS } from '../content/model';
import { hasActiveFilters, type BrowseState, type Sort, type View } from '../lib/filters';
import { PRICE_LABELS } from '../lib/format';

interface Props {
  state: BrowseState;
  total: number;
  count: number;
  cuisines: string[];
  neighborhoods: string[];
  onChange: (next: Partial<BrowseState>, options?: { replace?: boolean }) => void;
}

const VIEW_LABELS: Record<View, string> = { list: '列表', grid: '网格', map: '地图' };
const SORT_LABELS: Record<Sort, string> = { tier: '按评级', name: '按名称', price: '按人均' };

const selectClass =
  'h-10 min-w-0 shrink-0 rounded-full border border-line bg-white pr-8 pl-3 text-sm hover:border-chili-600 data-active:border-chili-600 data-active:bg-chili-50';

export function Toolbar({ state, total, count, cuisines, neighborhoods, onChange }: Props) {
  const filtered = hasActiveFilters(state);
  return (
    <div className="sticky top-0 z-[1100] border-b border-line bg-paper/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <label className="relative min-w-0 flex-1">
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
              value={state.query}
              onChange={(e) => onChange({ query: e.target.value }, { replace: true })}
              placeholder="搜索餐厅名称"
              enterKeyHint="search"
              className="h-11 w-full rounded-full border border-line bg-white pr-4 pl-10 text-base placeholder:text-muted/80 hover:border-chili-600"
            />
          </label>
          <nav
            aria-label="浏览方式"
            className="flex shrink-0 rounded-full border border-line bg-white p-1"
          >
            {(Object.keys(VIEW_LABELS) as View[]).map((view) => (
              <button
                key={view}
                type="button"
                aria-pressed={state.view === view}
                onClick={() => onChange({ view })}
                className="min-h-9 rounded-full px-3 text-sm font-semibold text-muted hover:text-ink aria-pressed:bg-ink aria-pressed:text-white sm:px-4"
              >
                {VIEW_LABELS[view]}
              </button>
            ))}
          </nav>
        </div>

        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]">
          <FilterSelect
            label="菜系"
            value={state.cuisine}
            options={cuisines.map((c) => [c, c])}
            onChange={(cuisine) => onChange({ cuisine })}
          />
          <FilterSelect
            label="区域"
            value={state.neighborhood}
            options={neighborhoods.map((n) => [n, n])}
            onChange={(neighborhood) => onChange({ neighborhood })}
          />
          <FilterSelect
            label="人均"
            value={state.price}
            options={PRICE_BUCKETS.map((b) => [b.id, PRICE_LABELS[b.id]])}
            onChange={(price) => onChange({ price: price as BrowseState['price'] })}
          />
          <label className="shrink-0">
            <span className="sr-only">排序</span>
            <select
              value={state.sort}
              onChange={(e) => onChange({ sort: e.target.value as Sort }, { replace: true })}
              className={selectClass}
            >
              {(Object.keys(SORT_LABELS) as Sort[]).map((sort) => (
                <option key={sort} value={sort}>
                  {SORT_LABELS[sort]}
                </option>
              ))}
            </select>
          </label>
          {filtered && (
            <button
              type="button"
              onClick={() => onChange({ query: '', cuisine: '', neighborhood: '', price: '' })}
              className="h-10 shrink-0 rounded-full px-3 text-sm font-semibold text-chili-700 hover:bg-chili-50"
            >
              清除筛选
            </button>
          )}
          <p className="ml-auto shrink-0 pl-2 text-sm text-muted" aria-live="polite">
            {filtered ? `找到 ${count} 家 / 共 ${total} 家` : `共 ${total} 家`}
          </p>
        </div>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  if (options.length === 0 && !value) return null;
  // Keep a value from a shared link selectable even if no restaurant uses it any more.
  const all: [string, string][] =
    value && !options.some(([v]) => v === value) ? [...options, [value, value]] : options;
  return (
    <label className="shrink-0">
      <span className="sr-only">按{label}筛选</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-active={value ? '' : undefined}
        className={selectClass}
      >
        <option value="">全部{label}</option>
        {all.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
