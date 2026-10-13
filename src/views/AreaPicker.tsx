import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LatLngValue } from '../../shared/submission';
import { PLACE_ZOOM, PRESET_AREAS, type SearchArea } from '../lib/areas';
import { geocode, geocodeAttribution, type GeocodeResult, type Place } from '../lib/geocode';
import { PoiError } from '../lib/poi';

type Locating = 'idle' | 'locating' | 'denied' | 'unavailable';

type Search =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'ready'; query: string; result: GeocodeResult }
  | { status: 'error'; query: string; message: string };

/**
 * "选择查找区域": one group of ways to move the map to where the restaurant
 * is — the Rice University and Chinatown presets (no request), the current
 * location (asked only on click), and an address or place search (run only
 * when submitted; an ambiguous search lists its results to choose from). It
 * only moves the map: choosing an area never selects a restaurant, and
 * `onLocate` reports a searched place separately so a caller can offer it as
 * a restaurant's location after the contributor confirms.
 */
export function AreaPicker({
  description,
  current,
  near,
  onLocate,
}: {
  description: string;
  /** Name of the area the map is showing now. */
  current: string;
  /** Searches prefer results near here (the map center). */
  near: LatLngValue;
  onLocate: (area: SearchArea, place?: Place) => void;
}) {
  const [locating, setLocating] = useState<Locating>('idle');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>({ status: 'idle' });
  const controller = useRef<AbortController>(undefined);
  useEffect(() => () => controller.current?.abort(), []);

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocating('unavailable');
      return;
    }
    setLocating('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // The device position only moves the map; it is never submitted as
        // the restaurant's location.
        setLocating('idle');
        onLocate({
          label: '当前位置附近',
          center: { lat: position.coords.latitude, lng: position.coords.longitude },
          zoom: PLACE_ZOOM,
        });
      },
      (error) => setLocating(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  const choosePlace = (place: Place) =>
    onLocate({ label: place.name, center: place.location, zoom: PLACE_ZOOM }, place);
  const runSearch = (text: string) => {
    const q = text.trim();
    if (!q) return;
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setSearch({ status: 'loading', query: q });
    geocode(q, near, c.signal).then(
      (result) => {
        if (c.signal.aborted) return;
        setSearch({ status: 'ready', query: q, result });
        // A single match moves the map at once; several are listed to choose from.
        if (result.places.length === 1) choosePlace(result.places[0]!);
      },
      (e: unknown) => {
        if (c.signal.aborted) return;
        const kind = e instanceof PoiError ? e.kind : 'failed';
        setSearch({
          status: 'error',
          query: q,
          message: kind === 'network' ? '网络连接失败，没能搜索这个地点。' : '地点搜索暂时不可用。',
        });
      },
    );
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    runSearch(query);
  };

  const button =
    'inline-flex min-h-11 items-center rounded-full border border-line bg-white px-4 text-sm font-semibold hover:border-chili-600 disabled:opacity-60';
  return (
    <section
      aria-labelledby="area-title"
      className="space-y-3 rounded-2xl border border-line bg-white p-4"
    >
      <div className="space-y-1">
        <h2 id="area-title" className="text-base font-bold">
          选择查找区域
        </h2>
        <p className="text-sm text-muted">{description}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {Object.values(PRESET_AREAS).map((area) => (
          <button key={area.label} type="button" onClick={() => onLocate(area)} className={button}>
            {area.label}
          </button>
        ))}
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating === 'locating'}
          className={button}
        >
          {locating === 'locating' ? '正在定位…' : '使用当前位置'}
        </button>
      </div>
      {(locating === 'denied' || locating === 'unavailable') && (
        <p role="status" className="text-sm text-chili-700">
          {locating === 'denied'
            ? '没有获得定位权限。可以选择上面的区域、输入地址，或直接拖动地图。'
            : '暂时无法获取当前位置。可以选择上面的区域、输入地址，或直接拖动地图。'}
        </p>
      )}

      <form role="search" aria-label="搜索地址或地点" onSubmit={onSubmit} className="space-y-1">
        <label htmlFor="area-query" className="block text-sm font-semibold">
          输入地址或地点
        </label>
        <div className="flex gap-2">
          <input
            id="area-query"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例如 2111 Norfolk St"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-white px-3"
          />
          <button
            type="submit"
            disabled={!query.trim() || search.status === 'loading'}
            className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-chili-600 px-4 text-sm font-semibold text-white hover:bg-chili-700 disabled:opacity-50"
          >
            搜索
          </button>
        </div>
      </form>
      <SearchResults search={search} onChoose={choosePlace} onRetry={runSearch} />

      <p role="status" className="text-sm font-semibold text-chili-700">
        当前查找区域：{current}
      </p>
    </section>
  );
}

function SearchResults({
  search,
  onChoose,
  onRetry,
}: {
  search: Search;
  onChoose: (place: Place) => void;
  onRetry: (query: string) => void;
}) {
  if (search.status === 'idle') return null;
  if (search.status === 'loading') {
    return (
      <p role="status" className="text-sm text-muted">
        正在搜索地点…
      </p>
    );
  }
  if (search.status === 'error') {
    return (
      <p role="status" className="text-sm text-chili-700">
        {search.message}可以
        <button
          type="button"
          onClick={() => onRetry(search.query)}
          className="mx-1 font-semibold underline"
        >
          重试
        </button>
        ，或直接拖动地图。
      </p>
    );
  }
  const { places, provider } = search.result;
  if (places.length === 0) {
    return (
      <p role="status" className="text-sm text-muted">
        没有找到「{search.query}」。可以换个写法（例如加上街道或城市），或直接拖动地图。
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {places.length > 1 && <p className="text-sm text-muted">找到多个地点，请选择：</p>}
      <ul aria-label="地点搜索结果" className="divide-y divide-line rounded-xl border border-line">
        {places.map((p) => (
          <li key={p.key}>
            <button
              type="button"
              onClick={() => onChoose(p)}
              className="block w-full px-3 py-2 text-left hover:bg-chili-50"
            >
              <span className="block text-sm font-semibold">{p.name}</span>
              {p.address && <span className="block text-xs text-muted">{p.address}</span>}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">{geocodeAttribution(provider)}</p>
    </div>
  );
}
