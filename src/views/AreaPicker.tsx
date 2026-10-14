import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LatLngValue } from '../../shared/submission';
import { PLACE_ZOOM, PRESET_AREAS, type SearchArea } from '../lib/areas';
import { GEOCODE_ATTRIBUTION, geocode, geocodingAvailable, type Place } from '../lib/geocode';
import { PoiError } from '../lib/poi';

type Locating = 'idle' | 'locating' | 'denied' | 'unavailable';

type Search =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'ready'; query: string; places: Place[] }
  | { status: 'error'; query: string; message: string };

/**
 * "选择查找区域": one group of ways to move the map to where the restaurant
 * is — the Rice University and Chinatown presets (no request), the current
 * location (asked only on click), and an address or place search (run only
 * when submitted; an ambiguous search lists its results to choose from). It
 * only moves the map: choosing an area never selects a restaurant, and
 * `onLocate` reports a searched place separately so a caller can offer it as
 * a restaurant's location after the contributor confirms.
 *
 * The last thing the contributor asked for wins, whatever order answers
 * arrive in: every action (a preset, "使用当前位置", a search, choosing a
 * result) starts a new generation and cancels the pending search; a search
 * answer or location callback from an older generation (or after unmount)
 * changes nothing, neither the map nor the messages.
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
  const generation = useRef(0);
  useEffect(
    () => () => {
      // Answers arriving after unmount are ignored.
      generation.current++;
      controller.current?.abort();
    },
    [],
  );

  /** Starts a new action: older pending answers no longer count. */
  const begin = () => {
    controller.current?.abort();
    controller.current = undefined;
    return ++generation.current;
  };
  const isCurrent = (gen: number) => gen === generation.current;

  const choosePreset = (area: SearchArea) => {
    begin();
    // Earlier results and messages belong to an earlier choice.
    setSearch({ status: 'idle' });
    setLocating('idle');
    onLocate(area);
  };

  const useMyLocation = () => {
    const gen = begin();
    setSearch({ status: 'idle' });
    if (!('geolocation' in navigator)) {
      setLocating('unavailable');
      return;
    }
    setLocating('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!isCurrent(gen)) return;
        // The device position only moves the map; it is never submitted as
        // the restaurant's location.
        setLocating('idle');
        onLocate({
          label: '当前位置附近',
          center: { lat: position.coords.latitude, lng: position.coords.longitude },
          zoom: PLACE_ZOOM,
        });
      },
      (error) => {
        if (!isCurrent(gen)) return;
        setLocating(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  const choosePlace = (place: Place) => {
    begin();
    setLocating('idle');
    onLocate({ label: place.name, center: place.location, zoom: PLACE_ZOOM }, place);
  };
  const runSearch = (text: string) => {
    const q = text.trim();
    if (!q) return;
    const gen = begin();
    const c = new AbortController();
    controller.current = c;
    setLocating('idle');
    setSearch({ status: 'loading', query: q });
    geocode(q, near, c.signal).then(
      (places) => {
        if (!isCurrent(gen)) return;
        setSearch({ status: 'ready', query: q, places });
        // A single match moves the map at once; several are listed to choose from.
        if (places.length === 1) {
          onLocate(
            { label: places[0]!.name, center: places[0]!.location, zoom: PLACE_ZOOM },
            places[0],
          );
        }
      },
      (e: unknown) => {
        if (!isCurrent(gen)) return;
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
          <button
            key={area.label}
            type="button"
            onClick={() => choosePreset(area)}
            className={button}
          >
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

      {geocodingAvailable() ? (
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
              disabled={!query.trim()}
              className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-chili-600 px-4 text-sm font-semibold text-white hover:bg-chili-700 disabled:opacity-50"
            >
              搜索
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted">
          地址搜索暂不可用。可以选择上面的区域、使用当前位置，或直接拖动地图。
        </p>
      )}
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
  const { places } = search;
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
      <p className="text-xs text-muted">{GEOCODE_ATTRIBUTION}</p>
    </div>
  );
}
