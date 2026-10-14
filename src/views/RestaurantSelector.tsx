import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
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
  tilesFor,
  type RestaurantCandidate,
} from '../lib/poi';
import { Alternative } from '../components/Alternative';
import { AreaPicker } from './AreaPicker';
import type { MapArea } from './PickerMap';
import type { Selection } from './submitTypes';

// Leaflet is only downloaded when a map is shown.
const PickerMap = lazy(() => import('./PickerMap'));

const START = { center: PRESET_AREAS.rice.center, zoom: PRESET_AREAS.rice.zoom };
/** Wait for the map to settle before loading its restaurants. */
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
 * Step 1, in two boxes: "选择查找区域" moves the map, then "选择餐厅" picks a
 * restaurant from the map. The map opens on Rice University (or the selected
 * restaurant, or where it was left) and shows the restaurants in view as named
 * pins. Searching by name (a fallback, like the address search above) narrows
 * the map and the list to the restaurants in view whose name matches, so the
 * list is always the map's area AND the name. Choosing a pin or a list entry
 * (or finishing a manual entry) selects it in place: the map focuses on it,
 * and the selected restaurant with "下一步" closes the page.
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
  /** The name search is a fallback, shown when asked for (or when it has a query). */
  const [nameOpen, setNameOpen] = useState(false);
  /** The list of restaurants in view, collapsed unless searching by name. */
  const [listOpen, setListOpen] = useState(false);
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

  const name = normalizeName(query);
  const searching = name !== '';
  // Tiles reach beyond the visible area; show (and count) what is in view.
  const inView = (c: RestaurantCandidate) =>
    !area ||
    (c.location.lat >= area.bounds.south &&
      c.location.lat <= area.bounds.north &&
      c.location.lng >= area.bounds.west &&
      c.location.lng <= area.bounds.east);
  const discovered =
    !tooWide && 'candidates' in discovery ? discovery.candidates.filter(inView) : [];
  // The map's area AND the name: the same restaurants on the map and in the list.
  const listed = searching
    ? discovered.filter((c) => normalizeName(c.name).includes(name))
    : discovered;
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
            poiId: selection.poi?.id ?? '',
            name: selection.name,
            location: selection.location,
            ...(selection.address ? { address: selection.address } : {}),
          },
        ]
      : listed;
  const showList = searching || listOpen;
  // What the list can say about the name search: matches only once the
  // restaurants in view have loaded, never "none" while loading or after an error.
  const nameState: 'results' | 'none' | 'loading' | 'error' | 'too-wide' =
    listed.length > 0
      ? 'results'
      : tooWide
        ? 'too-wide'
        : discovery.status === 'ready'
          ? 'none'
          : discovery.status === 'error'
            ? 'error'
            : 'loading';

  return (
    <div className="space-y-4">
      <AreaPicker
        description="先将地图定位到餐厅附近，再从地图上选择餐厅。"
        current={currentAreaLabel(searchArea, area?.center ?? view.center)}
        near={area?.center ?? view.center}
        intent={intent}
        onLocate={locate}
      />
      <section
        aria-labelledby="pick-title"
        className="space-y-3 rounded-2xl border border-line bg-white p-4"
      >
        <div className="space-y-1">
          <h2 id="pick-title" className="text-base font-bold">
            选择餐厅
          </h2>
          <p className="text-sm text-muted">点地图上的餐厅图钉或名字来选择。</p>
        </div>
        <Suspense fallback={<div className="h-80 rounded-xl bg-line sm:h-[28rem]" />}>
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

        <Alternative
          label="在当前区域搜索餐厅"
          open={nameOpen || searching}
          onToggle={() => {
            if (nameOpen || searching) setQuery('');
            setNameOpen((o) => !(o || searching));
          }}
        >
          <input
            type="search"
            aria-label="在当前区域搜索餐厅"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入餐厅名称"
            // Shown on request, so focus goes straight to it.
            autoFocus
            className="min-h-11 w-full rounded-xl border border-line bg-white px-3"
          />
          <p className="mt-1 text-xs text-muted">
            只在当前地图范围内查找；拖动或缩放地图后结果会更新。
          </p>
        </Alternative>

        {/* While searching by name the list always shows, with an accurate state. */}
        {(discovered.length > 0 || searching) && (
          <div className="rounded-xl border border-line">
            <button
              type="button"
              aria-expanded={showList}
              aria-controls="candidate-list"
              onClick={() => setListOpen((o) => !o)}
              disabled={searching}
              className="group flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-semibold disabled:cursor-default"
            >
              <svg
                viewBox="0 0 20 20"
                aria-hidden="true"
                className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none"
              >
                <path d="M7.5 4.5 13 10l-5.5 5.5-1.1-1.1L10.8 10 6.4 5.6z" fill="currentColor" />
              </svg>
              <span className="flex-1">
                {!searching
                  ? `列表查看地图范围内的 ${discovered.length} 家餐厅`
                  : nameState === 'results' || nameState === 'none'
                    ? `名称包含「${query.trim()}」的餐厅：${listed.length} 家`
                    : `名称包含「${query.trim()}」的餐厅`}
              </span>
            </button>
            {showList &&
              (nameState !== 'results' ? (
                <p
                  role="status"
                  className={`border-t border-line px-3 py-3 text-sm ${nameState === 'error' ? 'text-chili-700' : 'text-muted'}`}
                >
                  {nameState === 'too-wide'
                    ? '地图范围太大，放大地图后才能按名称查找。'
                    : nameState === 'loading'
                      ? '正在加载地图范围内的餐厅…'
                      : nameState === 'error'
                        ? '地图范围内的餐厅没能加载，暂时无法按名称查找。'
                        : '当前地图范围内没有这个名字的餐厅。可以换个写法、拖动或缩小地图，或手动添加。'}
                  {nameState === 'error' && (
                    <button
                      type="button"
                      onClick={() => setAttempt((n) => n + 1)}
                      className="ml-1 font-semibold text-chili-700 underline"
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
                  className="max-h-80 overflow-y-auto border-t border-line"
                />
              ))}
          </div>
        )}

        <p className="text-sm">
          还是找不到？
          <button
            type="button"
            onClick={() => setManual(true)}
            className="ml-1 font-semibold text-chili-700 underline"
          >
            手动添加餐厅
          </button>
        </p>
      </section>

      <p className="text-xs leading-5 text-muted">
        餐厅数据：{poiAttribution()}
        。查找餐厅时会把地图范围发送给这些数据服务；你的设备位置不会随投稿提交。
      </p>
      {selection && <SelectedRestaurant selection={selection} onNext={onNext} />}
    </div>
  );
}

/** Names compared loosely: width, case, and spacing do not matter. */
const normalizeName = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

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
    <ul id={id} aria-label={label} className={`divide-y divide-line ${className}`}>
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
      {!noLocation && (
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
      )}
      {/* Marking the restaurant is a box like "选择餐厅" on the selection page. */}
      <section
        aria-labelledby="mark-title"
        className="space-y-3 rounded-2xl border border-line bg-white p-4"
      >
        <h2 id="mark-title" className="text-base font-bold">
          标出餐厅位置
        </h2>
        {!noLocation && (
          <>
            {found && !sameLocation(found.location, marker) && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-chili-50 p-3 text-sm">
                <span>「{found.name}」就是餐厅的位置吗？</span>
                <button
                  type="button"
                  onClick={() => {
                    setMarker(found.location);
                    setAddress(found.address ?? found.name);
                  }}
                  className="font-semibold text-chili-700 underline"
                >
                  用这个地点作为餐厅位置
                </button>
              </div>
            )}
            <p className="text-sm">
              {marker ? '已标出位置，可以再点一下修改。' : '在地图上点一下餐厅所在的位置：'}
              {marker && address && <span className="block text-xs text-muted">{address}</span>}
            </p>
            <Suspense fallback={<div className="h-72 rounded-2xl bg-line sm:h-96" />}>
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
            className="mt-1 size-4"
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
