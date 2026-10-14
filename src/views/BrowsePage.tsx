import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { browseHref, navigate, restaurantHref, submitHref } from '../lib/router';
import { submissionFormId } from '../lib/submission';
import type { Insets } from './DiscoveryMap';
import { RestaurantDetails } from './RestaurantDetails';

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

/**
 * The discovery page. With `detailId`, the list area shows that restaurant's
 * details (the list keeps its state underneath) and the map selects it.
 */
export function BrowsePage({ params, detailId }: { params: URLSearchParams; detailId?: string }) {
  const [attempt, setAttempt] = useState(0);
  const content = useContentIndex(attempt);

  useEffect(() => {
    // The details set their own title once loaded.
    if (detailId === undefined) document.title = 'Rice Eats · 莱斯周边的美食地图';
  }, [detailId]);

  if (content.status === 'loading') return <Loading />;
  if (content.status === 'error') return <ErrorState onRetry={() => setAttempt((n) => n + 1)} />;
  return <Discovery index={content.data} params={params} detailId={detailId} />;
}

/**
 * The restaurant discovery page: the explorer (A: search, filters, sort,
 * list) decides the results; the map (B) shows them. Data flows one way:
 * moving the map never changes the search, filters, or sort, and the map
 * refits only when the set of results changes (not for a sort or a
 * selection). The visitor's location, used only for distance sorting, stays
 * in memory: it is never put in the URL or stored.
 */
function Discovery({
  index,
  params,
  detailId,
}: {
  index: ContentIndex;
  params: URLSearchParams;
  detailId?: string;
}) {
  const state = parseBrowseState(params);
  // The details select their restaurant on the map; the list's own selection waits underneath.
  const selected = detailId ?? state.selected;
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

  // A selection the filters no longer include is dropped (the details keep theirs).
  const selectionGone =
    detailId === undefined &&
    state.selected !== '' &&
    !filtered.some((r) => r.id === state.selected);
  useEffect(() => {
    if (selectionGone) {
      navigate(browseHref(toSearchParams({ ...state, selected: '' })), { replace: true });
    }
  });

  // The last sort the visitor chose wins: every choice starts a new
  // generation, and a location answer (success or failure) from an older one
  // changes nothing. The browser cannot cancel getCurrentPosition, so stale
  // callbacks are ignored instead; unmounting makes them all stale too.
  const sortGeneration = useRef(0);
  useEffect(
    () => () => {
      sortGeneration.current++;
    },
    [],
  );
  const onSort = (next: Sort) => {
    const generation = ++sortGeneration.current;
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
    const current = () => generation === sortGeneration.current;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!current()) return;
        setOrigin({ lat: position.coords.latitude, lng: position.coords.longitude });
        setLocating('idle');
      },
      (error) => {
        if (!current()) return;
        // Back to the previous sort (the one in the URL).
        setDistanceSort(false);
        setLocating(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  };

  // A link with a selected restaurant (or its details) opens the map on it.
  const [focusRequest, setFocusRequest] = useState(() => (selected ? 1 : 0));
  const [sheet, setSheet] = useState<SheetState>('half');
  const [sheetHeight, setSheetHeight] = useState(0);
  const onSheetHeight = useCallback((h: number) => setSheetHeight(h), []);
  const [hovered, setHovered] = useState('');

  // The browse state without a selection: what the details' links carry.
  const listParams = toSearchParams({ ...state, selected: '' });
  const detailHref = (id: string) => restaurantHref(id, listParams);
  // Opening details from the map keeps the map where the visitor put it;
  // from the list (or a link), the map moves to the restaurant.
  const [openedFromMap, setOpenedFromMap] = useState<string>();
  const [shownDetail, setShownDetail] = useState(detailId);
  if (detailId !== shownDetail) {
    setShownDetail(detailId);
    if (detailId !== undefined) {
      setHovered('');
      if (openedFromMap !== detailId) setFocusRequest((n) => n + 1);
      // On a phone, the details need room in the sheet; the map may be covered.
      setSheet((s) => (s === 'collapsed' ? 'half' : s));
    }
    setOpenedFromMap(undefined);
  }
  const openFromMap = (id: string) => {
    if (id === '' || id === detailId) return;
    setOpenedFromMap(id);
    // Moving between restaurants on the map replaces the details entry.
    navigate(detailHref(id), { replace: detailId !== undefined });
  };
  // Back to the list, with the restaurant still selected on the map.
  const backToList = () =>
    navigate(browseHref(toSearchParams({ ...state, selected: detailId ?? '' })), {
      replace: true,
    });

  if (all.length === 0) {
    return (
      <Message
        title="餐厅点评正在准备中"
        action={
          submissionFormId() && (
            <Link href={submitHref()} className="btn btn-primary">
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
      detailHref={detailHref}
      onHover={setHovered}
      onSearchFocus={() => {
        // Keep the field and results above the on-screen keyboard.
        if (!wide && sheet !== 'expanded') setSheet('expanded');
      }}
      footer={<FooterNotes className="px-3 py-4" />}
    />
  );
  const known = detailId !== undefined && all.some((r) => r.id === detailId);
  // The list stays mounted under the details, so going back finds it as it was.
  const panel = (
    <>
      <div hidden={detailId !== undefined} className="contents">
        {explorer}
      </div>
      {detailId !== undefined && (
        <RestaurantDetails key={detailId} id={detailId} known={known} onBack={backToList} />
      )}
    </>
  );
  const map = (
    <Suspense fallback={<Loading label="地图加载中…" />}>
      <DiscoveryMap
        restaurants={filtered}
        fitKey={fitKey}
        selected={selectionGone ? '' : selected}
        hovered={hovered}
        focusRequest={focusRequest}
        onSelect={openFromMap}
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
            className="flex min-h-0 w-[38%] max-w-[32rem] min-w-[20rem] flex-col border-r-2 border-ink bg-paper pt-2.5"
          >
            {panel}
          </section>
          <div className="relative min-h-0 flex-1">{map}</div>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="absolute inset-0">{map}</div>
          <BottomSheet state={sheet} onState={setSheet} onHeight={onSheetHeight}>
            {panel}
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
      className="shrink-0 border-b-2 border-ink bg-gold-100 px-4 py-1.5 text-center text-sm font-semibold text-gold-700"
    >
      {index.source === 'fixtures'
        ? '开发预览：当前显示的是虚构的示例数据，不是真实的餐厅推荐。'
        : '草稿预览：当前包含未发布的草稿，仅供本地审阅。'}
    </div>
  );
}
