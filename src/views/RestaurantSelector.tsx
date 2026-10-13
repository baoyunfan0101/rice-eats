import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { RICE_CENTER } from '../../shared/content/model';
import type { LatLngValue } from '../../shared/submission';
import {
  distanceText,
  POI_ATTRIBUTION,
  PoiError,
  poiApiKey,
  searchRestaurants,
  type RestaurantCandidate,
} from '../lib/poi';
import type { Selection } from './submitTypes';

// Leaflet is only downloaded when a map is shown.
const PickerMap = lazy(() => import('./PickerMap'));

const RADII = [300, 1000, 3000];
/** Name searches cover the area around the map center. */
const NAME_RADIUS = 5000;

type Results =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; candidates: RestaurantCandidate[] }
  | { status: 'error'; message: string };

type Locating = 'idle' | 'locating' | 'denied' | 'unavailable';

/**
 * Restaurant discovery: current location, a point on the map, or a name
 * search, with a manual entry when the place is not found. Searches run only
 * after a deliberate action (button, map tap, or a paused name query).
 */
export function RestaurantSelector({ onSelected }: { onSelected: (s: Selection) => void }) {
  const configured = Boolean(poiApiKey());
  const [view, setView] = useState({ center: RICE_CENTER, zoom: 15 });
  const mapCenter = useRef<LatLngValue>(RICE_CENTER);
  const [area, setArea] = useState<{ center: LatLngValue; radiusMeters: number }>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results>({ status: 'idle' });
  const [locating, setLocating] = useState<Locating>('idle');
  const [manual, setManual] = useState(false);
  const abort = useRef<AbortController | undefined>(undefined);

  const run = useCallback(
    async (center: LatLngValue, radiusMeters: number, name?: string) => {
      if (!configured) return;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setArea({ center, radiusMeters });
      setResults({ status: 'loading' });
      try {
        const candidates = await searchRestaurants(
          { center, radiusMeters, name },
          controller.signal,
        );
        if (!controller.signal.aborted) setResults({ status: 'ready', candidates });
      } catch (e) {
        if (controller.signal.aborted) return;
        const kind = e instanceof PoiError ? e.kind : 'failed';
        setResults({
          status: 'error',
          message:
            kind === 'quota'
              ? '餐厅搜索暂时不可用（服务额度已用完或被拒绝）。'
              : kind === 'network'
                ? '网络连接失败，没能搜索附近餐厅。'
                : '餐厅搜索出错了。',
        });
      }
    },
    [configured],
  );

  useEffect(() => () => abort.current?.abort(), []);

  // Name search: wait until typing pauses, then search around the map center.
  useEffect(() => {
    const name = query.trim();
    if (!name) return;
    const timer = setTimeout(() => void run(mapCenter.current, NAME_RADIUS, name), 400);
    return () => clearTimeout(timer);
  }, [query, run]);

  const searchAt = (center: LatLngValue, radius = RADII[0]!) => {
    setQuery('');
    void run(center, radius);
  };

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocating('unavailable');
      return;
    }
    setLocating('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // The device position is only used as a search center; it is never
        // submitted as the restaurant's location.
        const center = { lat: position.coords.latitude, lng: position.coords.longitude };
        setLocating('idle');
        setView({ center, zoom: 16 });
        searchAt(center);
      },
      (error) => setLocating(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  const nextRadius = area && RADII.find((r) => r > area.radiusMeters);

  if (manual) {
    return (
      <ManualEntry
        start={view}
        onCancel={() => setManual(false)}
        onDone={(selection) => onSelected(selection)}
      />
    );
  }

  return (
    <section aria-labelledby="pick-title" className="space-y-4">
      <div className="space-y-1">
        <h2 id="pick-title" className="text-lg font-bold">
          第一步：选择餐厅
        </h2>
        <p className="text-sm text-muted">
          用当前位置或在地图上点一下，查找附近的餐厅；也可以按名字搜索。
        </p>
      </div>

      {configured ? (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={useMyLocation}
              disabled={locating === 'locating'}
              className="inline-flex min-h-11 items-center rounded-full bg-chili-600 px-4 text-sm font-semibold text-white hover:bg-chili-700 disabled:opacity-60"
            >
              {locating === 'locating' ? '正在定位…' : '使用当前位置'}
            </button>
            <button
              type="button"
              onClick={() => searchAt(mapCenter.current)}
              className="inline-flex min-h-11 items-center rounded-full border border-line bg-white px-4 text-sm font-semibold hover:border-chili-600"
            >
              搜索地图中心附近
            </button>
          </div>
          {(locating === 'denied' || locating === 'unavailable') && (
            <p role="status" className="text-sm text-chili-700">
              {locating === 'denied'
                ? '没有获得定位权限。可以在地图上点选位置，或按名字搜索。'
                : '暂时无法获取当前位置。可以在地图上点选位置，或按名字搜索。'}
            </p>
          )}
          <label className="block">
            <span className="text-sm font-semibold">按名字搜索</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="餐厅名字（会在地图当前区域附近搜索）"
              className="mt-1 min-h-11 w-full rounded-xl border border-line bg-white px-3"
            />
          </label>
        </>
      ) : (
        <p role="status" className="rounded-xl bg-white p-3 text-sm text-muted">
          附近餐厅搜索暂不可用，请用下面的「手动添加餐厅」。
        </p>
      )}

      <Suspense fallback={<div className="h-72 rounded-2xl bg-line sm:h-96" />}>
        <PickerMap
          label="选择餐厅位置的地图"
          view={view}
          searchArea={area}
          candidates={results.status === 'ready' ? results.candidates : []}
          onMove={(center) => (mapCenter.current = center)}
          onMapClick={configured ? (point) => searchAt(point) : undefined}
          onSelect={(c) => onSelected(fromCandidate(c))}
        />
      </Suspense>

      <Results
        results={results}
        nextRadius={nextRadius}
        onExpand={() => area && nextRadius && void run(area.center, nextRadius)}
        onSelect={(c) => onSelected(fromCandidate(c))}
      />

      <div className="space-y-1 border-t border-line pt-4 text-sm">
        <p>
          找不到这家餐厅？
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
            使用定位或地图搜索时，搜索位置会发送给 Geoapify
            来查找附近餐厅；你的设备位置不会随投稿提交。
            {POI_ATTRIBUTION}
          </p>
        )}
      </div>
    </section>
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

function Results({
  results,
  nextRadius,
  onExpand,
  onSelect,
}: {
  results: Results;
  nextRadius?: number;
  onExpand: () => void;
  onSelect: (c: RestaurantCandidate) => void;
}) {
  if (results.status === 'idle') return null;
  if (results.status === 'loading') {
    return (
      <p role="status" className="text-sm text-muted">
        正在搜索附近的餐厅…
      </p>
    );
  }
  if (results.status === 'error') {
    return (
      <p role="status" className="text-sm text-chili-700">
        {results.message}可以换个位置再试，或手动添加餐厅。
      </p>
    );
  }
  const expand = nextRadius && (
    <button type="button" onClick={onExpand} className="font-semibold text-chili-700 underline">
      扩大搜索范围到 {distanceText(nextRadius)}
    </button>
  );
  if (results.candidates.length === 0) {
    return (
      <p role="status" className="text-sm text-muted">
        这里附近没有找到餐厅。{expand ?? '可以换个位置，'}或手动添加餐厅。
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <ul
        aria-label="附近的餐厅"
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
      {expand && <p className="text-sm">不在列表里？{expand}</p>}
    </div>
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
          placeholder="中文、英文都可以"
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
