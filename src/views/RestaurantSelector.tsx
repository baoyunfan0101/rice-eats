import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { RICE_CENTER } from '../../shared/content/model';
import type { LatLngValue } from '../../shared/submission';
import { currentAreaLabel, PRESET_AREAS, type SearchArea } from '../lib/areas';
import type { Place } from '../lib/geocode';
import { LocateIntent } from '../lib/locateIntent';
import {
  DISCOVERY_MIN_ZOOM,
  distanceMeters,
  distanceText,
  poiAttribution,
  PoiError,
  restaurantsInArea,
  searchRestaurants,
  tilesFor,
  type RestaurantCandidate,
} from '../lib/poi';
import { AreaPicker } from './AreaPicker';
import type { MapArea } from './PickerMap';
import type { Selection } from './submitTypes';

// Leaflet is only downloaded when a map is shown.
const PickerMap = lazy(() => import('./PickerMap'));

const START = { center: PRESET_AREAS.rice.center, zoom: PRESET_AREAS.rice.zoom };
/** Name searches cover the area around the map center. */
const NAME_RADIUS = 5000;
/**
 * Name searches use the map center snapped to this grid (about 2 km), so they
 * follow the map without re-running for every small pan (and repeat searches
 * hit the cache).
 */
const NAME_GRID = 0.02;
/** Wait for the map (or typing) to settle before searching. */
const SETTLE_MS = 400;

type Discovery =
  | { status: 'idle' }
  | { status: 'loading'; candidates: RestaurantCandidate[] }
  | {
      status: 'ready';
      candidates: RestaurantCandidate[];
      /** Tiles of the area that failed to load (the rest are shown). */
      failed: number;
      truncated: boolean;
    }
  /** Nothing in the area loaded; the previous pins stay. */
  | { status: 'error'; message: string; candidates: RestaurantCandidate[] };

/** Name search results, tagged with the query and area they belong to. */
type NameResults =
  | { status: 'idle' }
  | { status: 'loading'; for: string }
  | { status: 'ready'; for: string; candidates: RestaurantCandidate[] }
  | { status: 'error'; for: string; message: string };

function errorMessage(e: unknown): string {
  const kind = e instanceof PoiError ? e.kind : 'failed';
  return kind === 'quota'
    ? '餐厅搜索暂时不可用（服务额度已用完或被拒绝）。'
    : kind === 'network'
      ? '网络连接失败，没能加载附近的餐厅。'
      : '餐厅搜索出错了。';
}

export interface MapView {
  center: LatLngValue;
  zoom: number;
}

/** Key of a selection's pin: matches the candidate it came from. */
export function selectionKey(s: Selection): string {
  if (s.poi) return `${s.poi.provider}:${s.poi.id}`;
  if (s.restaurantId) return `existing:${s.restaurantId}`;
  return 'manual';
}

/** Zoom used when the map focuses on a selected restaurant. */
const FOCUS_ZOOM = 16;

/**
 * Step 1, map-first restaurant selection: the map opens on Rice University
 * (or the selected restaurant, or where it was left) and shows the restaurants in view as named
 * pins, updating as the map is panned or zoomed (including after
 * "使用当前位置", which only moves the map). Choosing a pin, a search result,
 * or a manual entry selects it in place: the map focuses on it, it is shown
 * below the map, and "下一步" continues to the form. A name search and a
 * manual entry cover places the map does not show.
 */
export function RestaurantSelector({
  selection,
  startView,
  startArea,
  onSelect,
  onNext,
  onViewChange,
  onAreaChange,
}: {
  selection?: Selection;
  /** Where the map was when the contributor last left this step. */
  startView?: MapView;
  /** The search area chosen before leaving this step. */
  startArea?: SearchArea;
  onSelect: (s: Selection) => void;
  onNext: () => void;
  onViewChange?: (v: MapView) => void;
  onAreaChange?: (a: SearchArea) => void;
}) {
  // Coming back to this step restores the map where the contributor left it;
  // otherwise the map opens on the selected restaurant (e.g. from a
  // restaurant page), or on Rice University.
  const [view, setView] = useState<MapView>(
    () =>
      startView ??
      (selection?.location && { center: selection.location, zoom: FOCUS_ZOOM }) ??
      START,
  );
  // The search area (where to look), separate from the selected restaurant.
  const [searchArea, setSearchArea] = useState<SearchArea>(
    () =>
      startArea ??
      (!startView && selection?.location
        ? { label: `「${selection.name}」附近`, center: selection.location, zoom: FOCUS_ZOOM }
        : PRESET_AREAS.rice),
  );
  /** Shared by the area controls and the map: the last thing the contributor did wins. */
  const [intent] = useState(() => new LocateIntent());
  const locate = (a: SearchArea) => {
    setSearchArea(a);
    onAreaChange?.(a);
    setView({ center: a.center, zoom: a.zoom });
  };
  const [area, setArea] = useState<MapArea>();
  const [discovery, setDiscovery] = useState<Discovery>({ status: 'idle' });
  const [query, setQuery] = useState('');
  const [named, setNamed] = useState<NameResults>({ status: 'idle' });
  const [manual, setManual] = useState(false);
  const discoverySeq = useRef(0);
  /** Bumped by "重试" to load the current area again (failed tiles are not cached). */
  const [attempt, setAttempt] = useState(0);

  // An area too large to search (zoomed far out) shows a hint instead.
  const tooWide = !!area && (area.zoom < DISCOVERY_MIN_ZOOM || !tilesFor(area.bounds));

  // Map discovery: once the map has settled, load the restaurants in view.
  useEffect(() => {
    if (!area || tooWide) return;
    const seq = ++discoverySeq.current;
    const timer = setTimeout(() => {
      setDiscovery((d) => ({
        status: 'loading',
        candidates: 'candidates' in d ? d.candidates : [],
      }));
      void restaurantsInArea(area.bounds).then((result) => {
        // Results for an area the map has left are ignored.
        if (seq !== discoverySeq.current) return;
        if (result.total > 0 && result.failed === result.total) {
          setDiscovery((d) => ({
            status: 'error',
            message: errorMessage(result.error),
            candidates: 'candidates' in d ? d.candidates : [],
          }));
        } else {
          setDiscovery({
            status: 'ready',
            candidates: result.candidates,
            failed: result.failed,
            truncated: result.truncated,
          });
        }
      });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [area, tooWide, attempt]);

  // Name search: wait until typing pauses, then search around the map center
  // (snapped to NAME_GRID). Moving the map to another cell searches again;
  // results are only shown for the query and cell they were made for.
  const snap = (v: number) => Number((Math.round(v / NAME_GRID) * NAME_GRID).toFixed(6));
  const nameLat = snap(area?.center.lat ?? RICE_CENTER.lat);
  const nameLng = snap(area?.center.lng ?? RICE_CENTER.lng);
  const name = query.trim();
  const nameKey = `${name}|${nameLat},${nameLng}`;
  useEffect(() => {
    if (!name) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setNamed({ status: 'loading', for: nameKey });
      searchRestaurants(
        { center: { lat: nameLat, lng: nameLng }, radiusMeters: NAME_RADIUS, name },
        controller.signal,
      ).then(
        (candidates) => {
          if (!controller.signal.aborted) setNamed({ status: 'ready', for: nameKey, candidates });
        },
        (e: unknown) => {
          if (!controller.signal.aborted) {
            setNamed({ status: 'error', for: nameKey, message: errorMessage(e) });
          }
        },
      );
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [name, nameLat, nameLng, nameKey]);
  // Results of an older query or area count as still loading.
  const current: NameResults =
    named.status === 'idle' || named.for === nameKey ? named : { status: 'loading', for: nameKey };

  /** Selects a restaurant in place and brings it into focus on the map. */
  const choose = (s: Selection) => {
    // Choosing a restaurant is the latest intent: no pending area answer may move the map away.
    intent.interrupt();
    onSelect(s);
    if (s.location) {
      setView({ center: s.location, zoom: Math.max(area?.zoom ?? FOCUS_ZOOM, FOCUS_ZOOM) });
    }
  };

  if (manual) {
    return (
      <ManualEntry
        start={area ? { center: area.center, zoom: area.zoom } : view}
        startArea={searchArea}
        onCancel={() => setManual(false)}
        onDone={(s) => {
          setManual(false);
          choose(s);
        }}
      />
    );
  }

  const searching = query.trim() !== '';
  // Tiles reach beyond the visible area; show (and count) what is in view.
  const inView = (c: RestaurantCandidate) =>
    !area ||
    (c.location.lat >= area.bounds.south &&
      c.location.lat <= area.bounds.north &&
      c.location.lng >= area.bounds.west &&
      c.location.lng <= area.bounds.east);
  const discovered =
    !tooWide && 'candidates' in discovery ? discovery.candidates.filter(inView) : [];
  const listed = searching ? (current.status === 'ready' ? current.candidates : []) : discovered;
  // The selected restaurant always has a pin, even when it came from a search
  // or a manual entry, or is out of the listed results.
  const selectedKey = selection ? selectionKey(selection) : undefined;
  const pins =
    selection?.location && !listed.some((c) => c.key === selectedKey)
      ? [
          ...listed,
          {
            key: selectedKey!,
            provider: selection.poi?.provider ?? selection.method,
            poiId: selection.poi?.id ?? '',
            name: selection.name,
            location: selection.location,
            ...(selection.address ? { address: selection.address } : {}),
          },
        ]
      : listed;

  return (
    <section aria-label="选择餐厅" className="space-y-4">
      <AreaPicker
        description="先将地图定位到餐厅附近，再从地图上选择餐厅。"
        current={currentAreaLabel(searchArea, area?.center ?? view.center)}
        near={area?.center ?? view.center}
        intent={intent}
        onLocate={locate}
      />
      <div className="space-y-1">
        <h2 className="text-base font-bold">选择餐厅</h2>
        <p className="text-sm text-muted">点地图上的餐厅图钉或名字来选择。</p>
      </div>
      <Suspense fallback={<div className="h-80 rounded-2xl bg-line sm:h-[28rem]" />}>
        <PickerMap
          label="附近餐厅地图"
          className="h-80 sm:h-[28rem]"
          view={view}
          candidates={pins}
          selectedKey={selectedKey}
          onMove={(a) => {
            setArea(a);
            onViewChange?.({ center: a.center, zoom: a.zoom });
          }}
          onUserMove={() => intent.interrupt()}
          onSelect={(c) => {
            // The selected pin itself keeps its selection (e.g. an existing restaurant).
            if (c.key !== selectedKey) choose(fromCandidate(c));
          }}
        />
      </Suspense>
      {selection && <SelectedRestaurant selection={selection} onNext={onNext} />}
      {!searching && (
        <DiscoveryStatus
          discovery={discovery}
          visible={discovered.length}
          tooWide={tooWide}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      )}
      {!searching && discovered.length > 0 && area && (
        // Where pins are too dense for every name (or on a small screen), the
        // restaurants in view can be read and chosen as a list.
        <details className="group rounded-2xl border border-line bg-white">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-semibold">
            按列表查看这 {discovered.length} 家餐厅
          </summary>
          <CandidateList
            label="地图上的餐厅"
            candidates={byDistance(discovered, area.center)}
            selectedKey={selectedKey}
            onSelect={(c) => choose(fromCandidate(c))}
            className="max-h-80 overflow-y-auto border-t border-line"
          />
        </details>
      )}

      <div className="space-y-2">
        <label className="block">
          <span className="text-sm font-semibold">在当前区域搜索餐厅</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入餐厅名称"
            aria-describedby="name-scope"
            className="mt-1 min-h-11 w-full rounded-xl border border-line bg-white px-3"
          />
        </label>
        <p id="name-scope" className="text-xs text-muted">
          搜索地图中心约 {distanceText(NAME_RADIUS)}{' '}
          范围内的餐厅；移动地图或切换区域后会在新位置重新搜索。
        </p>
        {searching && (
          <NameResultList
            results={current}
            selectedKey={selectedKey}
            onSelect={(c) => choose(fromCandidate(c))}
          />
        )}
      </div>

      <div className="space-y-1 border-t border-line pt-4 text-sm">
        <p>
          还是找不到？
          <button
            type="button"
            onClick={() => setManual(true)}
            className="ml-1 font-semibold text-chili-700 underline"
          >
            手动添加餐厅
          </button>
        </p>
        <p className="text-xs leading-5 text-muted">
          地图区域和名字搜索会发送给地图数据服务（Geoapify 或 OpenStreetMap
          Overpass）来查找餐厅；你的设备位置不会随投稿提交。{poiAttribution()}
        </p>
      </div>
    </section>
  );
}

function DiscoveryStatus({
  discovery,
  visible,
  tooWide,
  onRetry,
}: {
  discovery: Discovery;
  visible: number;
  tooWide: boolean;
  onRetry: () => void;
}) {
  const retry = (
    <button type="button" onClick={onRetry} className="ml-1 font-semibold text-chili-700 underline">
      重试
    </button>
  );
  let text: string | undefined;
  let warning: ReactNode;
  if (tooWide) text = '放大地图就能看到附近的餐厅。';
  else if (discovery.status === 'loading') text = '正在加载附近的餐厅…';
  else if (discovery.status === 'error') {
    text = `${discovery.message}可以重试、拖动地图，或按名字搜索、手动添加。`;
  } else if (discovery.status === 'ready') {
    text =
      visible === 0
        ? '这片区域没有找到餐厅，可以拖动地图看看别处。'
        : `地图上有 ${visible} 家餐厅，点图钉选择。`;
    if (discovery.failed > 0) warning = '部分区域没能加载，地图上的餐厅可能不全。';
    else if (discovery.truncated) {
      warning = '这一带餐厅很多，地图上可能没有全部显示；放大地图或按名字搜索可以找到更多。';
    }
  }
  const failed =
    !tooWide &&
    (discovery.status === 'error' || (discovery.status === 'ready' && discovery.failed > 0));
  return (
    <div role="status" className="space-y-1 text-sm">
      {text && (
        <p className={!tooWide && discovery.status === 'error' ? 'text-chili-700' : 'text-muted'}>
          {text}
          {discovery.status === 'error' && !tooWide && retry}
        </p>
      )}
      {warning && (
        <p className="text-chili-700">
          {warning}
          {failed && retry}
        </p>
      )}
    </div>
  );
}

const sameLocation = (a: LatLngValue, b: LatLngValue | undefined) =>
  !!b && a.lat === b.lat && a.lng === b.lng;

function fromCandidate(c: RestaurantCandidate): Selection {
  return {
    method: 'poi',
    name: c.name,
    address: c.address,
    location: c.location,
    poi: { provider: c.provider, id: c.poiId },
  };
}

function SelectedRestaurant({
  selection: s,
  onNext,
}: {
  selection: Selection;
  onNext: () => void;
}) {
  return (
    <section
      aria-label="已选餐厅"
      className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border-2 border-chili-600 bg-white p-4"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs font-semibold text-chili-700">已选餐厅</p>
        <p className="text-lg leading-snug font-bold">{s.name}</p>
        {s.address && <p className="text-sm text-muted">{s.address}</p>}
        {!s.location && (
          <p className="text-sm text-chili-700">没有位置信息，审核时会再核实餐厅的位置。</p>
        )}
      </div>
      <button
        type="button"
        onClick={onNext}
        className="inline-flex min-h-11 items-center rounded-full bg-chili-600 px-5 text-sm font-semibold text-white hover:bg-chili-700"
      >
        下一步：填写点评 →
      </button>
    </section>
  );
}

function NameResultList({
  results,
  selectedKey,
  onSelect,
}: {
  results: NameResults;
  selectedKey?: string;
  onSelect: (c: RestaurantCandidate) => void;
}) {
  if (results.status === 'idle') return null;
  if (results.status === 'loading') {
    return (
      <p role="status" className="text-sm text-muted">
        正在搜索…
      </p>
    );
  }
  if (results.status === 'error') {
    return (
      <p role="status" className="text-sm text-chili-700">
        {results.message}可以换个名字再试，或手动添加餐厅。
      </p>
    );
  }
  if (results.candidates.length === 0) {
    return (
      <p role="status" className="text-sm text-muted">
        地图附近没有找到这个名字的餐厅，可以换个写法，或手动添加餐厅。
      </p>
    );
  }
  return (
    <CandidateList
      label="搜索结果"
      candidates={results.candidates}
      selectedKey={selectedKey}
      onSelect={onSelect}
      className="rounded-2xl border border-line bg-white"
    />
  );
}

/**
 * Nearest the map center first. Distances are left out: they would be
 * measured from the map center, not from the contributor.
 */
function byDistance(candidates: RestaurantCandidate[], center: LatLngValue) {
  return candidates
    .map((c) => ({ c, d: distanceMeters(center, c.location) }))
    .sort((a, b) => a.d - b.d)
    .map(({ c: { distance: _, ...c } }) => c);
}

function CandidateList({
  label,
  candidates,
  selectedKey,
  onSelect,
  className,
}: {
  label: string;
  candidates: RestaurantCandidate[];
  selectedKey?: string;
  onSelect: (c: RestaurantCandidate) => void;
  className: string;
}) {
  return (
    <ul aria-label={label} className={`divide-y divide-line ${className}`}>
      {candidates.map((c) => (
        <li key={c.key}>
          <button
            type="button"
            onClick={() => onSelect(c)}
            aria-pressed={c.key === selectedKey}
            className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-chili-50 aria-pressed:bg-chili-50"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{c.name}</span>
              {c.address && <span className="block text-sm text-muted">{c.address}</span>}
            </span>
            {c.distance !== undefined && (
              <span className="shrink-0 text-sm text-muted">{distanceText(c.distance)}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Manual entry: the restaurant's name, an optional address, and its location
 * marked on the map. The map is located with the same area controls as the
 * selection map but shows no other restaurants. Locating an area only moves
 * the map; the restaurant's location is only ever the contributor's marker
 * (or a searched place they explicitly use as the marker), or none when they
 * are not sure.
 */
function ManualEntry({
  start,
  startArea,
  onCancel,
  onDone,
}: {
  start: { center: LatLngValue; zoom: number };
  startArea: SearchArea;
  onCancel: () => void;
  onDone: (s: Selection) => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [marker, setMarker] = useState<LatLngValue>();
  const [noLocation, setNoLocation] = useState(false);
  const [view, setView] = useState(start);
  const [center, setCenter] = useState(start.center);
  const [searchArea, setSearchArea] = useState(startArea);
  /** A searched place the contributor may use as the restaurant's location. */
  const [found, setFound] = useState<Place>();
  const [intent] = useState(() => new LocateIntent());
  const canContinue = name.trim() !== '' && (marker !== undefined || noLocation);

  return (
    <section aria-labelledby="manual-title" className="space-y-4">
      <div className="space-y-1">
        <h2 id="manual-title" className="text-lg font-bold">
          手动添加餐厅
        </h2>
        <p className="text-sm text-muted">填写餐厅名称，并在地图上点出餐厅的位置。</p>
      </div>
      <label className="block">
        <span className="text-sm font-semibold">餐厅名称</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 min-h-11 w-full rounded-xl border border-line bg-white px-3"
        />
      </label>
      <label className="block">
        <span className="text-sm font-semibold">餐厅地址（选填）</span>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="mt-1 min-h-11 w-full rounded-xl border border-line bg-white px-3"
        />
      </label>
      {!noLocation && (
        <div className="space-y-3">
          <AreaPicker
            description="先将地图定位到餐厅附近，再在地图上点出餐厅的位置。"
            current={currentAreaLabel(searchArea, center)}
            near={center}
            intent={intent}
            onLocate={(a, place) => {
              setSearchArea(a);
              setView({ center: a.center, zoom: a.zoom });
              setFound(place);
            }}
          />
          {found && !sameLocation(found.location, marker) && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-chili-50 p-3 text-sm">
              <span>「{found.name}」就是餐厅的位置吗？</span>
              <button
                type="button"
                onClick={() => {
                  setMarker(found.location);
                  if (!address.trim()) setAddress(found.address ?? found.name);
                }}
                className="font-semibold text-chili-700 underline"
              >
                用这个地点作为餐厅位置
              </button>
            </div>
          )}
          <p className="text-sm">
            {marker ? '已标出位置，可以再点一下修改。' : '在地图上点一下餐厅所在的位置：'}
          </p>
          <Suspense fallback={<div className="h-72 rounded-2xl bg-line sm:h-96" />}>
            <PickerMap
              label="标出餐厅位置的地图"
              view={view}
              marker={marker}
              onMapClick={(point) => {
                // Placing the restaurant is the latest intent: no pending answer may move the map.
                intent.interrupt();
                setMarker(point);
              }}
              onMove={(a) => setCenter(a.center)}
              onUserMove={() => intent.interrupt()}
            />
          </Suspense>
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={noLocation}
          onChange={(e) => {
            setNoLocation(e.target.checked);
            if (e.target.checked) setMarker(undefined);
          }}
          className="mt-1 size-4"
        />
        <span>我不确定具体位置（审核时会再核实位置）</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!canContinue}
          onClick={() =>
            onDone({
              method: 'manual',
              name: name.trim(),
              address: address.trim() || undefined,
              location: noLocation ? undefined : marker,
            })
          }
          className="inline-flex min-h-11 items-center rounded-full bg-chili-600 px-4 text-sm font-semibold text-white hover:bg-chili-700 disabled:opacity-50"
        >
          下一步
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex min-h-11 items-center rounded-full border border-line bg-white px-4 text-sm font-semibold hover:border-chili-600"
        >
          返回搜索
        </button>
      </div>
    </section>
  );
}
