import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { RICE_CENTER } from '../../shared/content/model';
import type { LatLngValue } from '../../shared/submission';
import {
  DISCOVERY_MIN_ZOOM,
  distanceText,
  POI_ATTRIBUTION,
  PoiError,
  poiApiKey,
  restaurantsInArea,
  searchRestaurants,
  tilesFor,
  type RestaurantCandidate,
} from '../lib/poi';
import type { MapArea } from './PickerMap';
import type { Selection } from './submitTypes';

// Leaflet is only downloaded when a map is shown.
const PickerMap = lazy(() => import('./PickerMap'));

const START = { center: RICE_CENTER, zoom: 15 };
/** Name searches cover the area around the map center. */
const NAME_RADIUS = 5000;
/** Wait for the map (or typing) to settle before searching. */
const SETTLE_MS = 400;

type Discovery =
  | { status: 'idle' }
  | { status: 'loading'; candidates: RestaurantCandidate[] }
  | { status: 'ready'; candidates: RestaurantCandidate[] }
  | { status: 'error'; message: string; candidates: RestaurantCandidate[] };

type NameResults =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; candidates: RestaurantCandidate[] }
  | { status: 'error'; message: string };

type Locating = 'idle' | 'locating' | 'denied' | 'unavailable';

function errorMessage(e: unknown): string {
  const kind = e instanceof PoiError ? e.kind : 'failed';
  return kind === 'quota'
    ? '餐厅搜索暂时不可用（服务额度已用完或被拒绝）。'
    : kind === 'network'
      ? '网络连接失败，没能加载附近的餐厅。'
      : '餐厅搜索出错了。';
}

/**
 * Map-first restaurant discovery: the map opens on Rice University and shows
 * the restaurants in view as pins, updating as the map is panned or zoomed
 * (including after "使用当前位置", which only moves the map). A name search
 * and a manual entry cover places the map does not show.
 */
export function RestaurantSelector({ onSelected }: { onSelected: (s: Selection) => void }) {
  const configured = Boolean(poiApiKey());
  const [view, setView] = useState(START);
  const [area, setArea] = useState<MapArea>();
  const [discovery, setDiscovery] = useState<Discovery>({ status: 'idle' });
  const [query, setQuery] = useState('');
  const [named, setNamed] = useState<NameResults>({ status: 'idle' });
  const [locating, setLocating] = useState<Locating>('idle');
  const [manual, setManual] = useState(false);
  const discoverySeq = useRef(0);

  // An area too large to search (zoomed far out) shows a hint instead.
  const tooWide = !!area && (area.zoom < DISCOVERY_MIN_ZOOM || !tilesFor(area.bounds));

  // Map discovery: once the map has settled, load the restaurants in view.
  useEffect(() => {
    if (!configured || !area || tooWide) return;
    const seq = ++discoverySeq.current;
    const timer = setTimeout(() => {
      setDiscovery((d) => ({
        status: 'loading',
        candidates: 'candidates' in d ? d.candidates : [],
      }));
      restaurantsInArea(area.bounds).then(
        (candidates) => {
          if (seq === discoverySeq.current) setDiscovery({ status: 'ready', candidates });
        },
        (e: unknown) => {
          if (seq !== discoverySeq.current) return;
          setDiscovery((d) => ({
            status: 'error',
            message: errorMessage(e),
            candidates: 'candidates' in d ? d.candidates : [],
          }));
        },
      );
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [area, configured, tooWide]);

  // Name search: wait until typing pauses, then search around the map center.
  const nameCenter = useRef<LatLngValue>(RICE_CENTER);
  useEffect(() => {
    nameCenter.current = area?.center ?? RICE_CENTER;
  }, [area]);
  useEffect(() => {
    const name = query.trim();
    if (!configured || !name) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setNamed({ status: 'loading' });
      searchRestaurants(
        { center: nameCenter.current, radiusMeters: NAME_RADIUS, name },
        controller.signal,
      ).then(
        (candidates) => setNamed({ status: 'ready', candidates }),
        (e: unknown) => {
          if (!controller.signal.aborted) setNamed({ status: 'error', message: errorMessage(e) });
        },
      );
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, configured]);

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocating('unavailable');
      return;
    }
    setLocating('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // The device position only moves the map; it is never submitted as
        // the restaurant's location. Discovery follows the map as usual.
        setLocating('idle');
        setView({
          center: { lat: position.coords.latitude, lng: position.coords.longitude },
          zoom: 16,
        });
      },
      (error) => setLocating(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  if (manual) {
    return (
      <ManualEntry
        start={area ? { center: area.center, zoom: area.zoom } : view}
        onCancel={() => setManual(false)}
        onDone={(selection) => onSelected(selection)}
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
  const pins = searching ? (named.status === 'ready' ? named.candidates : []) : discovered;

  return (
    <section aria-labelledby="pick-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pick-title" className="text-lg font-bold">
          选择餐厅
        </h2>
        {configured && (
          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating === 'locating'}
            className="inline-flex min-h-11 items-center rounded-full border border-line bg-white px-4 text-sm font-semibold hover:border-chili-600 disabled:opacity-60"
          >
            {locating === 'locating' ? '正在定位…' : '使用当前位置'}
          </button>
        )}
      </div>
      {(locating === 'denied' || locating === 'unavailable') && (
        <p role="status" className="text-sm text-chili-700">
          {locating === 'denied'
            ? '没有获得定位权限。可以直接拖动地图找到餐厅。'
            : '暂时无法获取当前位置。可以直接拖动地图找到餐厅。'}
        </p>
      )}
      {!configured && (
        <p role="status" className="rounded-xl bg-white p-3 text-sm text-muted">
          附近餐厅搜索暂不可用，请用下面的「手动添加餐厅」。
        </p>
      )}

      <Suspense fallback={<div className="h-80 rounded-2xl bg-line sm:h-[28rem]" />}>
        <PickerMap
          label="附近餐厅地图"
          className="h-80 sm:h-[28rem]"
          view={view}
          candidates={pins}
          onMove={setArea}
          onSelect={(c) => onSelected(fromCandidate(c))}
        />
      </Suspense>
      {configured && !searching && (
        <DiscoveryStatus discovery={discovery} visible={discovered.length} tooWide={tooWide} />
      )}

      {configured && (
        <div className="space-y-2">
          <label className="block">
            <span className="text-sm font-semibold">按名字搜索</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="地图上没找到？输入餐厅名字"
              className="mt-1 min-h-11 w-full rounded-xl border border-line bg-white px-3"
            />
          </label>
          {searching && (
            <NameResultList results={named} onSelect={(c) => onSelected(fromCandidate(c))} />
          )}
        </div>
      )}

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
        {configured && (
          <p className="text-xs leading-5 text-muted">
            地图区域和名字搜索会发送给 Geoapify 来查找餐厅；你的设备位置不会随投稿提交。
            {POI_ATTRIBUTION}
          </p>
        )}
      </div>
    </section>
  );
}

function DiscoveryStatus({
  discovery,
  visible,
  tooWide,
}: {
  discovery: Discovery;
  visible: number;
  tooWide: boolean;
}) {
  let text: string | undefined;
  if (tooWide) text = '放大地图就能看到附近的餐厅。';
  else if (discovery.status === 'loading') text = '正在加载附近的餐厅…';
  else if (discovery.status === 'error') {
    text = `${discovery.message}可以稍后再拖动地图试试，或按名字搜索、手动添加。`;
  } else if (discovery.status === 'ready') {
    text =
      visible === 0
        ? '这片区域没有找到餐厅，可以拖动地图看看别处。'
        : `地图上有 ${visible} 家餐厅，点图钉选择。`;
  }
  return (
    <p
      role="status"
      className={`text-sm ${!tooWide && discovery.status === 'error' ? 'text-chili-700' : 'text-muted'}`}
    >
      {text}
    </p>
  );
}

function fromCandidate(c: RestaurantCandidate): Selection {
  return {
    method: 'poi',
    name: c.name,
    address: c.address,
    location: c.location,
    poi: { provider: c.provider, id: c.poiId },
  };
}

function NameResultList({
  results,
  onSelect,
}: {
  results: NameResults;
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
    <ul
      aria-label="搜索结果"
      className="divide-y divide-line rounded-2xl border border-line bg-white"
    >
      {results.candidates.map((c) => (
        <li key={c.key}>
          <button
            type="button"
            onClick={() => onSelect(c)}
            className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-chili-50"
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
  const canContinue = name.trim() !== '' && (marker !== undefined || noLocation);

  return (
    <section aria-labelledby="manual-title" className="space-y-4">
      <div className="space-y-1">
        <h2 id="manual-title" className="text-lg font-bold">
          手动添加餐厅
        </h2>
        <p className="text-sm text-muted">填写餐厅名字，并在地图上点出餐厅的位置。</p>
      </div>
      <label className="block">
        <span className="text-sm font-semibold">餐厅名字</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 min-h-11 w-full rounded-xl border border-line bg-white px-3"
        />
      </label>
      <label className="block">
        <span className="text-sm font-semibold">地址（选填）</span>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="mt-1 min-h-11 w-full rounded-xl border border-line bg-white px-3"
        />
      </label>
      {!noLocation && (
        <div className="space-y-2">
          <p className="text-sm">
            {marker ? '已标出位置，可以再点一下修改。' : '在地图上点一下餐厅所在的位置：'}
          </p>
          <Suspense fallback={<div className="h-72 rounded-2xl bg-line sm:h-96" />}>
            <PickerMap
              label="标出餐厅位置的地图"
              view={start}
              marker={marker}
              onMapClick={setMarker}
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
