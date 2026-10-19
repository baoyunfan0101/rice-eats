import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isValidLatLng, type LatLngValue } from '../../shared/submission';
import { PRESET_AREAS, saveLastArea, type SearchArea } from '../lib/areas';
import { useContentIndex } from '../lib/content';
import type { Place } from '../lib/geocode';
import { geocodingAvailable } from '../lib/geocode';
import { LocateIntent } from '../lib/locateIntent';
import {
  DISCOVERY_MIN_ZOOM,
  distanceMeters,
  distanceText,
  poiAttribution,
  PoiError,
  restaurantsInArea,
  tilesFor,
  type RestaurantCandidate,
} from '../lib/poi';
import { PixelCheck, PixelChevron, PixelPin } from '../components/PixelIcons';
import { ListedBadge, MapSearch, normalizeName, type ListedRestaurant } from './MapSearch';
import type { MapArea } from './PickerMap';
import type { Selection } from './submitTypes';

// Leaflet is only downloaded when a map is shown.
const PickerMap = lazy(() => import('./PickerMap'));

const START = { center: PRESET_AREAS.rice.center, zoom: PRESET_AREAS.rice.zoom };
/** Wait for the map to settle before loading its restaurants. */
const SETTLE_MS = 400;

/** What is known about the restaurants of one map area (`for`: its key). */
type Discovery = { for?: string } & (
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
  | { status: 'error'; message: string; candidates: RestaurantCandidate[] }
);

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
 * Restaurants on Rice Eats: every one is found by name and other names; only
 * those with a valid location are map pins (none is ever placed elsewhere).
 */
function listedCandidates(
  restaurants: {
    id: string;
    name: string;
    altNames: string[];
    address?: string;
    location?: LatLngValue;
  }[],
) {
  return restaurants.map((r) => ({
    candidate: {
      key: `existing:${r.id}`,
      provider: 'existing',
      poiId: r.id,
      restaurantId: r.id,
      name: r.name,
      ...(r.address ? { address: r.address } : {}),
      ...(isValidLatLng(r.location) ? { location: r.location } : {}),
    } satisfies ListedRestaurant,
    names: [r.name, ...r.altNames].map(normalizeName),
  }));
}

const located = <T extends { candidate: ListedRestaurant }>(
  l: T,
): l is T & { candidate: RestaurantCandidate } => !!l.candidate.location;

/** A map place this close to a listed restaurant with the same name is that restaurant. */
const SAME_PLACE_METERS = 100;

/**
 * Step 1, one box "选择餐厅": a search box for a restaurant's name or an
 * address, map shortcuts (the current location, Rice University, Chinatown,
 * and the last location in this browser), and the map. The map opens on Rice
 * University (or the selected restaurant, or where it was left) and shows the
 * restaurants in view as named pins: restaurants already on Rice Eats in
 * their own color, places from the map data otherwise (a place that is a
 * listed restaurant shows once, as the listed one). Typing narrows the map
 * and the list to the names that match; searching also finds restaurants and
 * places beyond the map. Choosing a pin, a list entry, or a restaurant result
 * (or finishing a manual entry) selects it in place: the map focuses on it,
 * and the selected restaurant with "下一步" closes the page.
 */
export function RestaurantSelector({
  selection,
  startView,
  onSelect,
  onNext,
  onViewChange,
}: {
  selection?: Selection;
  /** Where the map was when the contributor last left this step. */
  startView?: MapView;
  onSelect: (s: Selection) => void;
  onNext: () => void;
  onViewChange?: (v: MapView) => void;
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
  /** Shared by the map shortcuts, the search, and the map: the last thing the contributor did wins. */
  const [intent] = useState(() => new LocateIntent());
  const locate = (a: SearchArea) => setView({ center: a.center, zoom: a.zoom });
  const [area, setArea] = useState<MapArea>();
  const [stored, setDiscovery] = useState<Discovery>({ status: 'idle' });
  const [query, setQuery] = useState('');
  // Restaurants on Rice Eats: their own pins, found by name wherever they are.
  const index = useContentIndex(0);
  const listedAll = useMemo(
    () => (index.status === 'ready' ? listedCandidates(index.data.restaurants) : []),
    [index],
  );
  /** The list of restaurants in view, collapsed unless searching by name. */
  const [listOpen, setListOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const discoverySeq = useRef(0);
  /** Bumped by "重试" to load the current area again (failed tiles are not cached). */
  const [attempt, setAttempt] = useState(0);

  // An area too large to search (zoomed far out) shows a hint instead.
  const tooWide = !!area && (area.zoom < DISCOVERY_MIN_ZOOM || !tilesFor(area.bounds));

  // The area the restaurants are for: what the map shows now (and the retry
  // count, so a retry never accepts an answer from before it).
  const b = area?.bounds;
  const areaKey = b ? `${b.south},${b.west},${b.north},${b.east}|${attempt}` : undefined;
  // Map discovery: once the map has settled, load the restaurants in view.
  // Any change of area (including zooming out too far) makes older requests
  // stale at once, not only when the next one starts after the pause.
  useEffect(() => {
    const seq = ++discoverySeq.current;
    if (!area || tooWide || !areaKey) return;
    const timer = setTimeout(() => {
      setDiscovery((d) => ({
        for: areaKey,
        status: 'loading',
        candidates: 'candidates' in d ? d.candidates : [],
      }));
      void restaurantsInArea(area.bounds).then((result) => {
        // Results for an area the map has left (or after leaving) are ignored.
        if (seq !== discoverySeq.current) return;
        if (result.total > 0 && result.failed === result.total) {
          setDiscovery((d) => ({
            for: areaKey,
            status: 'error',
            message: errorMessage(result.error),
            candidates: 'candidates' in d ? d.candidates : [],
          }));
        } else {
          setDiscovery({
            for: areaKey,
            status: 'ready',
            candidates: result.candidates,
            failed: result.failed,
            truncated: result.truncated,
          });
        }
      });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [area, tooWide, areaKey]);
  useEffect(
    () => () => {
      discoverySeq.current++;
    },
    [],
  );
  // What is known is about the current area only: an older area's state (even
  // "ready") counts as loading here until the current area's answer arrives;
  // its restaurants stay as pins meanwhile.
  const discovery: Discovery =
    stored.for === areaKey || !areaKey
      ? stored
      : {
          for: areaKey,
          status: 'loading',
          candidates: 'candidates' in stored ? stored.candidates : [],
        };

  /** Selects a restaurant in place and brings it into focus on the map. */
  const choose = (s: Selection) => {
    // Choosing a restaurant is the latest intent: no pending area answer may move the map away.
    intent.interrupt();
    onSelect(s);
    // The search did its job: the map now shows the chosen restaurant among its neighbors.
    setQuery('');
    if (s.location) {
      setView({ center: s.location, zoom: Math.max(area?.zoom ?? FOCUS_ZOOM, FOCUS_ZOOM) });
    }
  };

  if (manual) {
    return (
      <ManualEntry
        start={area ? { center: area.center, zoom: area.zoom } : view}
        onCancel={() => setManual(false)}
        onDone={(s) => {
          setManual(false);
          choose(s);
        }}
      />
    );
  }

  const name = normalizeName(query);
  const searching = name !== '';
  // Tiles reach beyond the visible area; show (and count) what is in view.
  const inView = (c: RestaurantCandidate) =>
    !area ||
    (c.location.lat >= area.bounds.south &&
      c.location.lat <= area.bounds.north &&
      c.location.lng >= area.bounds.west &&
      c.location.lng <= area.bounds.east);
  // Listed restaurants show once the map reports what is in view (never off-map pins).
  const listedInView = area ? listedAll.filter(located).filter((l) => inView(l.candidate)) : [];
  // A map place that is a listed restaurant shows once, as the listed one.
  const isListed = (c: RestaurantCandidate) =>
    listedInView.some(
      (l) =>
        l.names.includes(normalizeName(c.name)) &&
        distanceMeters(l.candidate.location, c.location) <= SAME_PLACE_METERS,
    );
  const fromMap = !tooWide && 'candidates' in discovery ? discovery.candidates.filter(inView) : [];
  const discovered = [
    ...listedInView.map((l) => l.candidate),
    ...fromMap.filter((c) => !isListed(c)),
  ];
  const matches = (c: RestaurantCandidate) => normalizeName(c.name).includes(name);
  // The map's area AND the name: the same restaurants on the map and in the list.
  const listed = searching
    ? [
        ...listedInView
          .filter((l) => l.names.some((n) => n.includes(name)))
          .map((l) => l.candidate),
        ...fromMap.filter((c) => !isListed(c) && matches(c)),
      ]
    : discovered;
  // Listed restaurants anywhere, for the search results.
  const listedMatches = searching
    ? listedAll.filter((l) => l.names.some((n) => n.includes(name))).map((l) => l.candidate)
    : [];
  // The selected restaurant always has a pin, even when it came from a manual
  // entry or is out of the listed results.
  const selectedKey = selection ? selectionKey(selection) : undefined;
  const pins =
    selection?.location && !listed.some((c) => c.key === selectedKey)
      ? [
          ...listed,
          {
            key: selectedKey!,
            provider: selection.poi?.provider ?? selection.method,
            poiId: selection.poi?.id ?? selection.restaurantId ?? '',
            ...(selection.restaurantId ? { restaurantId: selection.restaurantId } : {}),
            name: selection.name,
            location: selection.location,
            ...(selection.address ? { address: selection.address } : {}),
          },
        ]
      : listed;
  const showList = searching || listOpen;
  // What the list can say: a count (or "none") only once the current area's
  // own restaurants have loaded. Restaurants still shown from an earlier area
  // are not results for this one, so loading, an error, or a too-wide map
  // take precedence over them.
  const nameState: 'results' | 'none' | 'loading' | 'error' | 'too-wide' = tooWide
    ? 'too-wide'
    : discovery.status === 'error'
      ? 'error'
      : discovery.status !== 'ready'
        ? 'loading'
        : listed.length > 0
          ? 'results'
          : 'none';

  return (
    <div className="space-y-4">
      <section aria-labelledby="pick-title" className="card space-y-3 p-4">
        <div className="window-bar -mx-4 -mt-4">
          <PixelPin className="size-4 text-chili-600" />
          <h2 id="pick-title" className="text-base font-black">
            选择餐厅
          </h2>
        </div>
        <MapSearch
          label="搜索餐厅名称或地址"
          placeholder={geocodingAvailable() ? '搜索餐厅名称或地址' : '搜索餐厅名称'}
          query={query}
          onQueryChange={setQuery}
          near={area?.center ?? view.center}
          intent={intent}
          listed={listedMatches}
          onChooseRestaurant={(c) => choose(fromCandidate(c))}
          onLocate={locate}
        />
        <p className="text-sm text-muted">
          点地图上的图钉或名字来选择；绿色图钉是 Rice Eats 已收录的餐厅。
        </p>
        <Suspense fallback={<div className="h-80 border-2 border-ink bg-sand sm:h-[28rem]" />}>
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
        <DiscoveryStatus
          discovery={discovery}
          visible={discovered.length}
          tooWide={tooWide}
          onRetry={() => setAttempt((n) => n + 1)}
        />

        {/* While a name is typed the list always shows, with an accurate state. */}
        {(discovered.length > 0 || searching) && (
          <div className="border-2 border-ink">
            <button
              type="button"
              aria-expanded={showList}
              aria-controls="candidate-list"
              onClick={() => setListOpen((o) => !o)}
              disabled={searching}
              className="group flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-bold hover:bg-gold-100 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <PixelChevron className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none" />
              <span className="flex-1">
                {!searching
                  ? `列表查看地图范围内的 ${discovered.length} 家餐厅`
                  : nameState === 'results' || nameState === 'none'
                    ? `地图范围内名称包含「${query.trim()}」的餐厅：${listed.length} 家`
                    : `地图范围内名称包含「${query.trim()}」的餐厅`}
              </span>
            </button>
            {showList &&
              (nameState !== 'results' ? (
                <p
                  role="status"
                  className={`border-t-2 border-ink px-3 py-3 text-sm ${nameState === 'error' ? 'text-chili-700' : 'text-muted'}`}
                >
                  {nameState === 'too-wide'
                    ? '地图范围太大，放大地图后才能按名称查找。'
                    : nameState === 'loading'
                      ? '正在加载地图范围内的餐厅…'
                      : nameState === 'error'
                        ? '地图范围内的餐厅没能加载，暂时无法按名称查找。'
                        : '地图范围内没有这个名字的餐厅。可以按「搜索」在更大范围里找，或手动添加。'}
                  {nameState === 'error' && (
                    <button
                      type="button"
                      onClick={() => setAttempt((n) => n + 1)}
                      className="text-action ml-1"
                    >
                      重试
                    </button>
                  )}
                </p>
              ) : (
                <CandidateList
                  id="candidate-list"
                  label="地图上的餐厅"
                  candidates={area ? byDistance(listed, area.center) : listed}
                  selectedKey={selectedKey}
                  onSelect={(c) => choose(fromCandidate(c))}
                  className="max-h-80 overflow-y-auto border-t-2 border-ink"
                />
              ))}
          </div>
        )}

        <p className="text-sm">
          找不到？
          <button type="button" onClick={() => setManual(true)} className="text-action ml-1">
            手动添加餐厅
          </button>
        </p>
      </section>

      <p className="text-xs leading-5 text-muted">
        餐厅数据：{poiAttribution()}
        。查找餐厅时会把地图范围和搜索内容发送给这些数据服务；你的设备位置不会随投稿提交。「上次的位置」只保存在这个浏览器里。
      </p>
      {selection && (
        <SelectedRestaurant
          selection={selection}
          onNext={() => {
            if (area) saveLastArea(area);
            onNext();
          }}
        />
      )}
    </div>
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
    <button type="button" onClick={onRetry} className="text-action ml-1">
      重试
    </button>
  );
  let text: string | undefined;
  let warning: ReactNode;
  if (tooWide) text = '放大地图就能看到附近的餐厅。';
  else if (discovery.status === 'loading') text = '正在加载附近的餐厅…';
  else if (discovery.status === 'error') {
    text = `${discovery.message}可以重试、拖动地图，或手动添加。`;
  } else if (discovery.status === 'ready') {
    text =
      visible === 0
        ? '这片区域没有找到餐厅，可以拖动地图看看别处。'
        : `地图上有 ${visible} 家餐厅，点图钉选择。`;
    if (discovery.failed > 0) warning = '部分区域没能加载，地图上的餐厅可能不全。';
    else if (discovery.truncated) {
      warning = '这一带餐厅很多，地图上可能没有全部显示；放大地图可以看到更多。';
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

function fromCandidate(c: ListedRestaurant): Selection {
  if (c.restaurantId) {
    // A listed restaurant keeps its id; without a location it has none here either.
    return {
      method: 'existing',
      restaurantId: c.restaurantId,
      name: c.name,
      address: c.address,
      ...(c.location ? { location: c.location } : {}),
    };
  }
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
      className="card flex flex-wrap items-end justify-between gap-3 bg-gold-100 p-4 shadow-px-lg"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="flex items-center gap-1.5 text-xs font-bold text-chili-700">
          <PixelCheck className="size-3.5" />
          已选餐厅
        </p>
        <p className="text-lg leading-snug font-black">{s.name}</p>
        {s.address && <p className="text-sm text-muted">{s.address}</p>}
        {!s.location && (
          <p className="text-sm text-chili-700">没有位置信息，审核时会再核实餐厅的位置。</p>
        )}
      </div>
      <button type="button" onClick={onNext} className="btn btn-primary px-5">
        下一步：填写点评 →
      </button>
    </section>
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
  id,
  label,
  candidates,
  selectedKey,
  onSelect,
  className,
}: {
  id?: string;
  label: string;
  candidates: RestaurantCandidate[];
  selectedKey?: string;
  onSelect: (c: RestaurantCandidate) => void;
  className: string;
}) {
  return (
    <ul id={id} aria-label={label} className={`divide-y-2 divide-sand ${className}`}>
      {candidates.map((c) => (
        <li key={c.key}>
          <button
            type="button"
            onClick={() => onSelect(c)}
            aria-pressed={c.key === selectedKey}
            className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-gold-100 aria-pressed:bg-gold-300"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-bold">
                {c.name}
                {c.restaurantId && <ListedBadge />}
              </span>
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
 * Manual entry: the restaurant's name and its location marked on the map. The
 * map is located with the same area controls as the selection map (whose
 * address search replaces a separate address field) but shows no other
 * restaurants. Locating an area only moves the map; the restaurant's location
 * is only ever the contributor's marker (or a searched place they explicitly
 * use as the marker, whose address is then kept), or none when they are not
 * sure.
 */
function ManualEntry({
  start,
  onCancel,
  onDone,
}: {
  start: { center: LatLngValue; zoom: number };
  onCancel: () => void;
  onDone: (s: Selection) => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [marker, setMarker] = useState<LatLngValue>();
  const [noLocation, setNoLocation] = useState(false);
  const [view, setView] = useState(start);
  const [center, setCenter] = useState(start.center);
  const [query, setQuery] = useState('');
  /** A searched place the contributor may use as the restaurant's location. */
  const [found, setFound] = useState<Place>();
  const [intent] = useState(() => new LocateIntent());
  const canContinue = name.trim() !== '' && (marker !== undefined || noLocation);

  return (
    <section aria-labelledby="manual-title" className="space-y-4">
      <div className="space-y-1">
        <h2 id="manual-title" className="section-title text-lg">
          手动添加餐厅
        </h2>
        <p className="text-sm text-muted">填写餐厅名称，并在地图上点出餐厅的位置。</p>
      </div>
      <label className="block">
        <span className="text-sm font-bold">餐厅名称</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="field mt-1 w-full"
        />
      </label>
      {/* Marking the restaurant is a box like "选择餐厅" on the selection page. */}
      <section aria-labelledby="mark-title" className="card space-y-3 p-4">
        <div className="window-bar -mx-4 -mt-4">
          <PixelPin className="size-4 text-chili-600" />
          <h2 id="mark-title" className="text-base font-black">
            标出餐厅位置
          </h2>
        </div>
        {!noLocation && (
          <>
            <MapSearch
              label="搜索地址或地点"
              placeholder="例如 2111 Norfolk St"
              query={query}
              onQueryChange={setQuery}
              near={center}
              intent={intent}
              onLocate={(a, place) => {
                setView({ center: a.center, zoom: a.zoom });
                setFound(place);
              }}
            />
            {found && !sameLocation(found.location, marker) && (
              <div className="flex flex-wrap items-center gap-2 border-2 border-ink bg-gold-100 p-3 text-sm">
                <span>「{found.name}」就是餐厅的位置吗？</span>
                <button
                  type="button"
                  onClick={() => {
                    setMarker(found.location);
                    setAddress(found.address ?? found.name);
                  }}
                  className="text-action"
                >
                  用这个地点作为餐厅位置
                </button>
              </div>
            )}
            <p className="text-sm font-semibold">
              {marker ? '已标出位置，可以再点一下修改。' : '在地图上点一下餐厅所在的位置：'}
              {marker && address && <span className="block text-xs text-muted">{address}</span>}
            </p>
            <Suspense fallback={<div className="h-72 border-2 border-ink bg-sand sm:h-96" />}>
              <PickerMap
                label="标出餐厅位置的地图"
                view={view}
                marker={marker}
                markerLabel={name.trim() || '餐厅位置'}
                onMapClick={(point) => {
                  // Placing the restaurant is the latest intent: no pending answer may move the map.
                  intent.interrupt();
                  setMarker(point);
                  // A hand-placed marker has no known address.
                  setAddress('');
                }}
                onMove={(a) => setCenter(a.center)}
                onUserMove={() => intent.interrupt()}
              />
            </Suspense>
          </>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={noLocation}
            onChange={(e) => {
              setNoLocation(e.target.checked);
              if (e.target.checked) setMarker(undefined);
            }}
            className="mt-0.5 size-4 accent-chili-600"
          />
          <span>我不确定具体位置（审核时会再核实位置）</span>
        </label>
      </section>
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
          className="btn btn-primary"
        >
          下一步
        </button>
        <button type="button" onClick={onCancel} className="btn">
          返回搜索
        </button>
      </div>
    </section>
  );
}
