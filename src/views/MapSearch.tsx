import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { LatLngValue } from '../../shared/submission';
import { loadLastArea, PLACE_ZOOM, PRESET_AREAS, type SearchArea } from '../lib/areas';
import { GEOCODE_ATTRIBUTION, geocode, geocodingAvailable, type Place } from '../lib/geocode';
import type { LocateIntent } from '../lib/locateIntent';
import { distanceMeters, PoiError, type RestaurantCandidate } from '../lib/poi';
import { PixelTarget } from '../components/PixelIcons';

type Locating = 'idle' | 'locating' | 'denied' | 'unavailable';

type Search =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'ready'; query: string; places: Place[] }
  | { status: 'error'; query: string; message: string };

/** Names compared loosely: width, case, and spacing do not matter. */
export const normalizeName = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** A searched place to eat, as a map candidate (its Geoapify POI). */
const asCandidate = (p: Place): RestaurantCandidate => ({
  key: `${p.restaurant!.provider}:${p.restaurant!.id}`,
  provider: p.restaurant!.provider,
  poiId: p.restaurant!.id,
  name: p.name,
  ...(p.address ? { address: p.address } : {}),
  location: p.location,
});

/**
 * The search box and the map shortcuts above the map of step 1: one box for
 * a restaurant's name or an address, "使用当前位置" (asked only on click),
 * the Rice University and Chinatown presets, and "上次的位置" when this
 * browser remembers one.
 *
 * Typing only updates `query` (the caller narrows the map to matching
 * names). Submitting also searches beyond the map: with `onChooseRestaurant`,
 * the results are grouped into restaurants (the `listed` ones on Rice Eats
 * first, then searched places to eat), which are chosen directly, and
 * addresses or places, which only move the map. Without it (manual entry)
 * every result is a place. A single place moves the map at once.
 *
 * The last thing the contributor asked for wins, whatever order answers
 * arrive in: every action starts a new generation of the shared `intent` and
 * cancels the pending search; so does moving the map by hand (the map calls
 * `intent.interrupt()`). An answer from an older generation (or after
 * unmount) changes nothing.
 */
export function MapSearch({
  label,
  placeholder,
  query,
  onQueryChange,
  near,
  intent,
  listed = [],
  onChooseRestaurant,
  onLocate,
}: {
  /** Accessible name of the search box. */
  label: string;
  placeholder: string;
  query: string;
  onQueryChange: (query: string) => void;
  /** Searches prefer results near here (the map center). */
  near: LatLngValue;
  /** Shared with the map, so that moving the map by hand also counts as an action. */
  intent: LocateIntent;
  /** Restaurants on Rice Eats whose name matches the query, wherever they are. */
  listed?: RestaurantCandidate[];
  onChooseRestaurant?: (c: RestaurantCandidate) => void;
  onLocate: (area: SearchArea, place?: Place) => void;
}) {
  const [locating, setLocating] = useState<Locating>('idle');
  const [search, setSearch] = useState<Search>({ status: 'idle' });
  const [lastArea] = useState(loadLastArea);
  useEffect(() => {
    const unsubscribe = intent.onInterrupt(() => {
      // The contributor moved the map: nothing pending applies any more.
      setSearch((s) => (s.status === 'loading' ? { status: 'idle' } : s));
      setLocating((l) => (l === 'locating' ? 'idle' : l));
    });
    return () => {
      unsubscribe();
      // Answers arriving after unmount are ignored.
      intent.begin();
    };
  }, [intent]);

  const isCurrent = (gen: number) => intent.isCurrent(gen);
  const choosePreset = (area: SearchArea) => {
    intent.begin();
    // Earlier results and messages belong to an earlier choice.
    setSearch({ status: 'idle' });
    setLocating('idle');
    onLocate(area);
  };

  const useMyLocation = () => {
    const { generation: gen } = intent.begin();
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
    intent.begin();
    setLocating('idle');
    onLocate({ label: place.name, center: place.location, zoom: PLACE_ZOOM }, place);
  };
  const runSearch = (text: string) => {
    const q = text.trim();
    if (!q) return;
    const { generation: gen, signal } = intent.begin();
    setLocating('idle');
    if (!geocodingAvailable()) {
      setSearch({ status: 'ready', query: q, places: [] });
      return;
    }
    setSearch({ status: 'loading', query: q });
    geocode(q, near, signal).then(
      (places) => {
        if (!isCurrent(gen)) return;
        setSearch({ status: 'ready', query: q, places });
        // A single place (not a restaurant to choose) moves the map at once.
        const only = places.length === 1 ? places[0]! : undefined;
        if (only && !(onChooseRestaurant && only.restaurant) && listed.length === 0) {
          onLocate({ label: only.name, center: only.location, zoom: PLACE_ZOOM }, only);
        }
      },
      (e: unknown) => {
        if (!isCurrent(gen)) return;
        const kind = e instanceof PoiError ? e.kind : 'failed';
        setSearch({
          status: 'error',
          query: q,
          message: kind === 'network' ? '网络连接失败，没能完成搜索。' : '搜索暂时不可用。',
        });
      },
    );
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    runSearch(query);
  };
  // Results belong to the query they were found for.
  const results = search.status !== 'idle' && search.query === query.trim() ? search : undefined;

  return (
    <div className="space-y-3">
      <form role="search" aria-label={label} onSubmit={onSubmit} className="flex gap-2">
        <input
          type="search"
          aria-label={label}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          className="field min-w-0 flex-1"
        />
        <button type="submit" disabled={!query.trim()} className="btn btn-dark shrink-0">
          搜索
        </button>
      </form>
      {results && (
        <SearchResults
          search={results}
          listed={onChooseRestaurant ? listed : []}
          onChooseRestaurant={onChooseRestaurant}
          onChoosePlace={choosePlace}
          onRetry={runSearch}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {/* The current location is the first choice; the shortcuts follow. */}
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating === 'locating'}
          className="btn btn-primary btn-sm"
        >
          <PixelTarget className="size-4" />
          {locating === 'locating' ? '正在定位…' : '使用当前位置'}
        </button>
        {[...Object.values(PRESET_AREAS), ...(lastArea ? [lastArea] : [])].map((area) => (
          <button
            key={area.label}
            type="button"
            onClick={() => choosePreset(area)}
            className="btn btn-sm"
          >
            {area.label}
          </button>
        ))}
      </div>
      {(locating === 'denied' || locating === 'unavailable') && (
        <p role="status" className="text-sm font-semibold text-chili-700">
          {locating === 'denied' ? '没有获得定位权限。' : '暂时无法获取当前位置。'}
          可以搜索餐厅或地址、点上面的地点，或直接拖动地图。
        </p>
      )}
    </div>
  );
}

function SearchResults({
  search,
  listed,
  onChooseRestaurant,
  onChoosePlace,
  onRetry,
}: {
  search: Exclude<Search, { status: 'idle' }>;
  listed: RestaurantCandidate[];
  onChooseRestaurant?: (c: RestaurantCandidate) => void;
  onChoosePlace: (place: Place) => void;
  onRetry: (query: string) => void;
}) {
  const places = search.status === 'ready' ? search.places : [];
  // A searched place to eat that is already on Rice Eats is shown once, as the listed one.
  const isListed = (c: RestaurantCandidate) =>
    listed.some(
      (l) =>
        normalizeName(l.name) === normalizeName(c.name) &&
        distanceMeters(l.location, c.location) <= 150,
    );
  const found = onChooseRestaurant
    ? places
        .filter((p) => p.restaurant)
        .map(asCandidate)
        .filter((c) => !isListed(c))
    : [];
  const restaurants = [...listed, ...found];
  const others = onChooseRestaurant ? places.filter((p) => !p.restaurant) : places;
  const note =
    search.status === 'loading'
      ? '正在搜索…'
      : search.status === 'error'
        ? search.message
        : restaurants.length + others.length === 0
          ? `没有找到「${search.query}」。可以换个写法（例如加上街道或城市），或拖动地图在附近找找。`
          : undefined;
  return (
    <div className="space-y-2">
      {note && (
        <p
          role="status"
          className={`text-sm ${search.status === 'error' ? 'text-chili-700' : 'text-muted'}`}
        >
          {note}
          {search.status === 'error' && (
            <button
              type="button"
              onClick={() => onRetry(search.query)}
              className="text-action ml-1"
            >
              重试
            </button>
          )}
        </p>
      )}
      {!geocodingAvailable() && search.status === 'ready' && (
        <p className="text-sm text-muted">地址搜索暂不可用，只能找到 Rice Eats 已收录的餐厅。</p>
      )}
      {restaurants.length > 0 && (
        <ResultGroup title="餐厅" hint="点一下直接选择">
          {restaurants.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => onChooseRestaurant?.(c)}
                className="block w-full px-3 py-2 text-left hover:bg-gold-100"
              >
                <span className="block text-sm font-bold">
                  {c.name}
                  {c.restaurantId && <ListedBadge />}
                </span>
                {c.address && <span className="block text-xs text-muted">{c.address}</span>}
              </button>
            </li>
          ))}
        </ResultGroup>
      )}
      {others.length > 0 && (
        <ResultGroup title="地址或地点" hint="点一下把地图移过去，再从地图上选择">
          {others.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                onClick={() => onChoosePlace(p)}
                className="block w-full px-3 py-2 text-left hover:bg-gold-100"
              >
                <span className="block text-sm font-bold">{p.name}</span>
                {p.address && <span className="block text-xs text-muted">{p.address}</span>}
              </button>
            </li>
          ))}
        </ResultGroup>
      )}
      {places.length > 0 && <p className="text-xs text-muted">{GEOCODE_ATTRIBUTION}</p>}
    </div>
  );
}

function ResultGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm">
        <span className="font-black">{title}</span>
        <span className="ml-2 text-xs text-muted">{hint}</span>
      </p>
      <ul
        aria-label={title}
        className="max-h-64 divide-y-2 divide-sand overflow-y-auto border-2 border-ink"
      >
        {children}
      </ul>
    </div>
  );
}

/** Marks a restaurant already on Rice Eats (same color as its pin). */
export function ListedBadge() {
  return (
    <span className="ml-2 inline-block border-2 border-ink bg-basil-50 px-1 align-middle text-xs font-bold text-basil-600">
      已收录
    </span>
  );
}
