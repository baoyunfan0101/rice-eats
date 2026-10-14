import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { ContentIndex, LatLng } from '../../shared/content/model';
import { RATINGS } from '../../shared/content/vocabulary';
import { BottomSheet, type SheetState } from '../components/BottomSheet';
import { Explorer, type Locating } from '../components/Explorer';
import { FooterNotes } from '../components/Layout';
import { Link } from '../components/Link';
import { ErrorState, Loading, Message } from '../components/States';
import { useContentIndex } from '../lib/content';
import {
  facetValues,
  filterRestaurants,
  parseBrowseState,
  resultKey,
  sortRestaurants,
  toSearchParams,
  type BrowseState,
  type Sort,
} from '../lib/filters';
import { distanceMeters } from '../lib/poi';
import { browseHref, navigate, submitHref } from '../lib/router';
import { submissionFormId } from '../lib/submission';
import type { Insets } from './DiscoveryMap';

// Leaflet is downloaded separately so the list shows without waiting for it.
const DiscoveryMap = lazy(() => import('./DiscoveryMap'));

/** Wide screens show the explorer and the map side by side; narrow ones a map with a bottom sheet. */
const WIDE = '(min-width: 768px)';

function useMediaQuery(query: string): boolean {
  const get = () => typeof window.matchMedia !== 'function' || window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

export function BrowsePage({ params }: { params: URLSearchParams }) {
  const [attempt, setAttempt] = useState(0);
  const content = useContentIndex(attempt);

  useEffect(() => {
    document.title = 'Rice Eats · 莱斯大学周边美食指南';
  }, []);

  if (content.status === 'loading') return <Loading />;
  if (content.status === 'error') return <ErrorState onRetry={() => setAttempt((n) => n + 1)} />;
  return <Discovery index={content.data} params={params} />;
}

/**
 * The restaurant discovery page: the explorer (A: search, filters, sort,
 * list) decides the results; the map (B) shows them. Data flows one way:
 * moving the map never changes the search, filters, or sort, and the map
 * refits only when the set of results changes (not for a sort or a
 * selection). The visitor's location, used only for distance sorting, stays
 * in memory: it is never put in the URL or stored.
 */
function Discovery({ index, params }: { index: ContentIndex; params: URLSearchParams }) {
  const state = parseBrowseState(params);
  const all = index.restaurants;
  const wide = useMediaQuery(WIDE);

  const [distanceSort, setDistanceSort] = useState(false);
  const [origin, setOrigin] = useState<LatLng>();
  const [locating, setLocating] = useState<Locating>('idle');
  const sort: Sort = distanceSort ? 'distance' : state.sort;

  const filterKey = toSearchParams({ ...state, sort: 'rating', selected: '' }).toString();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- filterKey stands for the filters
  const filtered = useMemo(() => filterRestaurants(all, state), [all, filterKey]);
  const results = useMemo(
    () => sortRestaurants(filtered, distanceSort && origin ? 'distance' : state.sort, origin),
    [filtered, distanceSort, origin, state.sort],
  );
  const located = useMemo(() => filtered.filter((r) => r.location), [filtered]);
  const fitKey = useMemo(() => resultKey(located), [located]);
  const distances = useMemo(() => {
    if (!origin) return undefined;
    const map = new Map<string, number>();
    for (const r of filtered) if (r.location) map.set(r.id, distanceMeters(origin, r.location));
    return map;
  }, [filtered, origin]);
  const facets = useMemo(
    () => ({
      cuisines: facetValues(all, (r) => r.cuisines),
      tags: facetValues(all, (r) => r.tags),
      ratings: RATINGS.filter((rating) => all.some((r) => r.rating === rating)),
    }),
    [all],
  );

  const update = (next: Partial<BrowseState>, options: { replace?: boolean } = {}) =>
    navigate(browseHref(toSearchParams({ ...state, ...next })), options);

  // A selection the filters no longer include has no preview.
  const selectionGone = state.selected !== '' && !filtered.some((r) => r.id === state.selected);
  useEffect(() => {
    if (selectionGone) {
      navigate(browseHref(toSearchParams({ ...state, selected: '' })), { replace: true });
    }
  });

  const onSort = (next: Sort) => {
    if (next !== 'distance') {
      setDistanceSort(false);
      setLocating('idle');
      update({ sort: next }, { replace: true });
      return;
    }
    // The location is asked for only now, never on page load.
    if (!('geolocation' in navigator)) {
      setLocating('unavailable');
      return;
    }
    setLocating('locating');
    setDistanceSort(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setOrigin({ lat: position.coords.latitude, lng: position.coords.longitude });
        setLocating('idle');
      },
      (error) => {
        // Back to the previous sort (the one in the URL).
        setDistanceSort(false);
        setLocating(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  };

  // A link with a selected restaurant (e.g. from its page) opens the map on it.
  const [focusRequest, setFocusRequest] = useState(() => (state.selected ? 1 : 0));
  const [sheet, setSheet] = useState<SheetState>('half');
  const [sheetHeight, setSheetHeight] = useState(0);
  const onSheetHeight = useCallback((h: number) => setSheetHeight(h), []);
  const locate = (id: string) => {
    update({ selected: id }, { replace: true });
    setFocusRequest((n) => n + 1);
    // On a phone, make room for the map; the list keeps its state.
    if (!wide) setSheet('collapsed');
  };

  if (all.length === 0) {
    return (
      <Message
        title="餐厅点评正在准备中"
        action={
          submissionFormId() && (
            <Link href={submitHref()} className="font-semibold text-chili-700 underline">
              推荐一家餐厅或分享照片
            </Link>
          )
        }
      >
        第一批餐厅点评还在整理，很快就会上线。欢迎之后再来看看！
      </Message>
    );
  }

  const insets: Insets = wide ? { top: 0, bottom: 0 } : { top: 0, bottom: sheetHeight };
  const explorer = (
    <Explorer
      state={state}
      total={all.length}
      results={results}
      facets={facets}
      sort={sort}
      locating={locating}
      distances={distanceSort ? distances : undefined}
      onChange={update}
      onSort={onSort}
      onLocate={locate}
      onSearchFocus={() => {
        // Keep the field and results above the on-screen keyboard.
        if (!wide && sheet !== 'expanded') setSheet('expanded');
      }}
      footer={<FooterNotes className="px-3 py-4" />}
    />
  );
  const map = (
    <Suspense fallback={<Loading label="地图加载中…" />}>
      <DiscoveryMap
        restaurants={filtered}
        fitKey={fitKey}
        selected={selectionGone ? '' : state.selected}
        focusRequest={focusRequest}
        onSelect={(id) => update({ selected: id }, { replace: true })}
        insets={insets}
      />
    </Suspense>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SourceNotice index={index} />
      {wide ? (
        <div className="flex min-h-0 flex-1">
          <section
            aria-label="餐厅探索"
            className="flex min-h-0 w-[38%] max-w-[32rem] min-w-[20rem] flex-col border-r border-line bg-paper pt-2"
          >
            {explorer}
          </section>
          <div className="relative min-h-0 flex-1">{map}</div>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="absolute inset-0">{map}</div>
          <BottomSheet state={sheet} onState={setSheet} onHeight={onSheetHeight}>
            {explorer}
          </BottomSheet>
        </div>
      )}
    </div>
  );
}

function SourceNotice({ index }: { index: ContentIndex }) {
  if (index.source !== 'fixtures' && !index.includesDrafts) return null;
  return (
    <div
      role="note"
      className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900"
    >
      {index.source === 'fixtures'
        ? '开发预览：当前显示的是虚构的示例数据，不是真实的餐厅推荐。'
        : '草稿预览：当前包含未发布的草稿，仅供本地审阅。'}
    </div>
  );
}
