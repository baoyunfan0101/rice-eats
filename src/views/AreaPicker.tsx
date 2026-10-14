import { useEffect, useState, type FormEvent } from 'react';
import type { LatLngValue } from '../../shared/submission';
import { PLACE_ZOOM, PRESET_AREAS, type SearchArea } from '../lib/areas';
import { GEOCODE_ATTRIBUTION, geocode, geocodingAvailable, type Place } from '../lib/geocode';
import type { LocateIntent } from '../lib/locateIntent';
import { PoiError } from '../lib/poi';
import { Alternative } from '../components/Alternative';
import { PixelTarget } from '../components/PixelIcons';

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
 * result) starts a new generation of the shared `intent` and cancels the
 * pending search; so does moving the map by hand (the map calls
 * `intent.interrupt()`), which also clears a pending "searching" or
 * "locating" state. A search answer or location callback from an older
 * generation (or after unmount) changes nothing, neither the map nor the
 * messages.
 */
export function AreaPicker({
  description,
  current,
  near,
  intent,
  onLocate,
}: {
  description: string;
  /** Shared with the map, so that moving the map by hand also counts as an action. */
  intent: LocateIntent;
  /** Name of the area the map is showing now. */
  current: string;
  /** Searches prefer results near here (the map center). */
  near: LatLngValue;
  onLocate: (area: SearchArea, place?: Place) => void;
}) {
  const [locating, setLocating] = useState<Locating>('idle');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>({ status: 'idle' });
  /** The address search is a fallback, shown when asked for. */
  const [addressOpen, setAddressOpen] = useState(false);
  useEffect(() => {
    const unsubscribe = intent.onInterrupt(() => {
      // The contributor moved the map: nothing pending applies any more.
      setSearch((s) => (s.status === 'loading' || s.status === 'error' ? { status: 'idle' } : s));
      setLocating((l) => (l === 'locating' ? 'idle' : l));
    });
    return () => {
      unsubscribe();
      // Answers arriving after unmount are ignored.
      intent.begin();
    };
  }, [intent]);

  /** Starts a new action: older pending answers no longer count. */
  const begin = () => intent.begin();
  const isCurrent = (gen: number) => intent.isCurrent(gen);

  const choosePreset = (area: SearchArea) => {
    begin();
    // Earlier results and messages belong to an earlier choice.
    setSearch({ status: 'idle' });
    setLocating('idle');
    onLocate(area);
  };

  const useMyLocation = () => {
    const { generation: gen } = begin();
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
    const { generation: gen, signal } = begin();
    setLocating('idle');
    setSearch({ status: 'loading', query: q });
    geocode(q, near, signal).then(
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

  return (
    <section aria-labelledby="area-title" className="card space-y-3 p-4">
      <div className="window-bar -mx-4 -mt-4">
        <PixelTarget className="size-4 text-chili-600" />
        <h2 id="area-title" className="text-base font-black">
          选择查找区域
        </h2>
      </div>
      <p className="text-sm text-muted">{description}</p>
      <div className="flex flex-wrap gap-2">
        {/* The current location is the first choice; the presets follow. */}
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating === 'locating'}
          className="btn btn-primary"
        >
          <PixelTarget className="size-4" />
          {locating === 'locating' ? '正在定位…' : '使用当前位置'}
        </button>
        {Object.values(PRESET_AREAS).map((area) => (
          <button key={area.label} type="button" onClick={() => choosePreset(area)} className="btn">
            {area.label}
          </button>
        ))}
      </div>
      {(locating === 'denied' || locating === 'unavailable') && (
        <p role="status" className="text-sm font-semibold text-chili-700">
          {locating === 'denied'
            ? '没有获得定位权限。可以选择 Rice 或 Chinatown、输入地址，或直接拖动地图。'
            : '暂时无法获取当前位置。可以选择 Rice 或 Chinatown、输入地址，或直接拖动地图。'}
        </p>
      )}

      {geocodingAvailable() ? (
        <Alternative
          label="输入地址或地点"
          open={addressOpen}
          onToggle={() => setAddressOpen((o) => !o)}
        >
          <form role="search" aria-label="搜索地址或地点" onSubmit={onSubmit} className="space-y-2">
            <div className="flex gap-2">
              <input
                type="search"
                aria-label="输入地址或地点"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="例如 2111 Norfolk St"
                // Shown on request, so focus goes straight to it.
                autoFocus
                className="field min-w-0 flex-1"
              />
              <button type="submit" disabled={!query.trim()} className="btn btn-dark shrink-0">
                搜索
              </button>
            </div>
            <SearchResults search={search} onChoose={choosePlace} onRetry={runSearch} />
          </form>
        </Alternative>
      ) : (
        <p className="text-sm text-muted">
          地址搜索暂不可用。可以使用当前位置、选择上面的区域，或直接拖动地图。
        </p>
      )}

      <p
        role="status"
        className="border-t-2 border-dashed border-ink/25 pt-2.5 text-sm font-bold text-chili-700"
      >
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
        <button type="button" onClick={() => onRetry(search.query)} className="text-action mx-1">
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
      <ul aria-label="地点搜索结果" className="divide-y-2 divide-sand border-2 border-ink">
        {places.map((p) => (
          <li key={p.key}>
            <button
              type="button"
              onClick={() => onChoose(p)}
              className="block w-full px-3 py-2 text-left hover:bg-gold-100"
            >
              <span className="block text-sm font-bold">{p.name}</span>
              {p.address && <span className="block text-xs text-muted">{p.address}</span>}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">{GEOCODE_ATTRIBUTION}</p>
    </div>
  );
}
