import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import { RICE_CENTER, type LatLng, type RestaurantSummary } from '../../shared/content/model';
import { RatingBadge } from '../components/Badges';
import { Link } from '../components/Link';
import { RestaurantImage } from '../components/RestaurantImage';
import { metaLine } from '../lib/format';
import { onUserMove } from '../lib/mapGestures';
import { restaurantHref } from '../lib/router';
import { TILE_ATTRIBUTION, TILE_URL } from '../lib/tiles';

const pinIcons = {
  normal: L.divIcon({ className: 'map-pin', html: '<span></span>', iconSize: [32, 32] }),
  selected: L.divIcon({
    className: 'map-pin is-selected',
    html: '<span></span>',
    iconSize: [32, 32],
  }),
};

/** Fitting never zooms in closer than this (one restaurant), nor out further than MIN_FIT_ZOOM. */
const MAX_FIT_ZOOM = 15;
const MIN_FIT_ZOOM = 10;
/** Zoom used when the list asks to show one restaurant. */
const FOCUS_ZOOM = 16;
/** Height the preview card needs above the overlays, with its margins. */
const PREVIEW_SPACE = 160;
/** Typing changes the results often; the map refits once the results settle. */
const FIT_DELAY_MS = 250;

/** Space covered by overlays (the mobile bottom sheet), in pixels. */
export interface Insets {
  top: number;
  bottom: number;
}

export interface MapProps {
  /** The restaurants of the current results (any order; only their set matters). */
  restaurants: RestaurantSummary[];
  /**
   * Changes exactly when the set of results changes. The map refits then, and
   * only then: never for a new sort, a selection, or a re-render.
   */
  fitKey: string;
  selected: string;
  /** Bumped when the list asks to show `selected` on the map. */
  focusRequest: number;
  onSelect: (id: string) => void;
  /** Overlays covering the map; fitting and focusing keep restaurants out from under them. */
  insets?: Insets;
}

type Located = RestaurantSummary & { location: LatLng };

/**
 * B, the restaurant map: shows the restaurants the explorer (A) selected and
 * never changes them. Panning and zooming are the visitor's own; the map only
 * moves by itself when the results change (fit), or when the list asks to
 * show one restaurant (focus).
 */
export default function DiscoveryMap({
  restaurants,
  fitKey,
  selected,
  focusRequest,
  onSelect,
  insets = { top: 0, bottom: 0 },
}: MapProps) {
  const located = useMemo(
    () => restaurants.filter((r): r is Located => r.location !== undefined),
    [restaurants],
  );
  const missing = restaurants.length - located.length;
  const current = restaurants.find((r) => r.id === selected);
  const [tilesFailed, setTilesFailed] = useState(false);
  const pendingFitRef = useRef<() => void>(undefined);
  // The preview needs room above the overlays (the expanded bottom sheet
  // leaves almost none): without it, the pin stays selected and the preview
  // comes back when there is room again.
  const frame = useRef<HTMLDivElement>(null);
  const [frameHeight, setFrameHeight] = useState(0);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const update = () => setFrameHeight(element.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const previewFits = frameHeight - insets.top - insets.bottom >= PREVIEW_SPACE;

  return (
    <div
      ref={frame}
      role="region"
      aria-label="餐厅地图"
      className="relative h-full w-full overflow-hidden"
    >
      <MapContainer
        center={[RICE_CENTER.lat, RICE_CENTER.lng]}
        zoom={13}
        className="h-full w-full bg-line"
      >
        <TileLayer
          url={TILE_URL}
          attribution={TILE_ATTRIBUTION}
          maxZoom={19}
          eventHandlers={{ tileerror: () => setTilesFailed(true) }}
        />
        <FocusWithoutScrolling />
        <KeepSize />
        <FitToResults
          located={located}
          fitKey={fitKey}
          insets={insets}
          pendingRef={pendingFitRef}
        />
        <FocusSelected
          restaurant={current?.location ? (current as Located) : undefined}
          request={focusRequest}
          insets={insets}
          pendingFitRef={pendingFitRef}
        />
        {located.map((r) => (
          <Marker
            key={r.id}
            position={[r.location.lat, r.location.lng]}
            icon={r.id === selected ? pinIcons.selected : pinIcons.normal}
            title={r.name}
            alt={r.name}
            zIndexOffset={r.id === selected ? 1000 : 0}
            eventHandlers={{
              click: () => onSelect(r.id),
              // Leaflet makes markers focusable but does not activate them from the keyboard.
              keypress: (e) => {
                const key = (e as L.LeafletKeyboardEvent).originalEvent.key;
                if (key === 'Enter' || key === ' ') onSelect(r.id);
              },
            }}
          />
        ))}
      </MapContainer>

      <div
        className="pointer-events-none absolute right-3 left-3 z-[1000] flex flex-col items-end gap-2"
        style={{ top: insets.top + 12 }}
      >
        {located.length === 0 && restaurants.length > 0 && (
          <p role="status" className="rounded-full bg-white/95 px-3 py-1 text-xs text-muted shadow">
            当前结果都没有位置信息
          </p>
        )}
        {missing > 0 && located.length > 0 && (
          <p className="rounded-full bg-white/95 px-3 py-1 text-xs text-muted shadow">
            {missing} 家餐厅暂无位置信息，未在地图上显示
          </p>
        )}
        {tilesFailed && (
          <p
            role="status"
            className="rounded-full bg-white/95 px-3 py-1 text-xs text-chili-700 shadow"
          >
            部分地图底图加载失败，标记位置仍然有效
          </p>
        )}
      </div>

      {current && previewFits && (
        <Preview restaurant={current} bottom={insets.bottom} onClose={() => onSelect('')} />
      )}
    </div>
  );
}

function Preview({
  restaurant: r,
  bottom,
  onClose,
}: {
  restaurant: RestaurantSummary;
  bottom: number;
  onClose: () => void;
}) {
  return (
    <section
      aria-label={`${r.name} 预览`}
      className="absolute right-3 left-3 z-[1000] mx-auto flex max-w-md gap-3 rounded-2xl bg-white p-3 shadow-xl sm:right-auto sm:left-4 sm:w-96"
      style={{ bottom: bottom + 16 }}
    >
      <RestaurantImage
        decorative
        image={r.cover}
        sizes="96px"
        className="aspect-square w-20 shrink-0 rounded-xl sm:w-24"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 leading-snug font-bold">{r.name}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭预览"
            className="-mt-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-line/60"
          >
            ✕
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <RatingBadge rating={r.rating} />
          <span className="truncate">{metaLine(r)}</span>
        </div>
        <Link
          href={restaurantHref(r.id)}
          className="mt-auto self-start rounded-full bg-chili-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-chili-700"
        >
          查看详情
        </Link>
      </div>
    </section>
  );
}

/**
 * Leaflet focuses the map container on mousedown (for keyboard panning) without
 * `preventScroll`, which on small screens scrolls the page between press and
 * release, so taps on markers miss. Focus without scrolling instead.
 */
function FocusWithoutScrolling() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const focus = container.focus.bind(container);
    container.focus = (options?: FocusOptions) => focus({ ...options, preventScroll: true });
  }, [map]);
  return null;
}

/** Keeps Leaflet's size in step with its container (window resizes, the bottom sheet). */
function KeepSize() {
  const map = useMap();
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return null;
}

/**
 * Fits the map to the results whenever their set changes (fitKey), keeping
 * them clear of overlays. Several restaurants: their bounds, between
 * MIN_FIT_ZOOM and MAX_FIT_ZOOM; one: centered at MAX_FIT_ZOOM; none with a
 * location: no move. The first fit is immediate, later ones wait for the
 * results to settle (typing) and animate.
 */
function FitToResults({
  located,
  fitKey,
  insets,
  pendingRef,
}: {
  located: Located[];
  fitKey: string;
  insets: Insets;
  /** Cancels the fit waiting for its delay, if any. */
  pendingRef: RefObject<(() => void) | undefined>;
}) {
  const map = useMap();
  const fitted = useRef<string>(undefined);
  const latest = useRef({ located, insets });
  useEffect(() => {
    latest.current = { located, insets };
  });
  useEffect(() => {
    if (fitted.current === fitKey) return;
    const first = fitted.current === undefined;
    const fit = () => {
      fitted.current = fitKey;
      const { located: places, insets: inset } = latest.current;
      if (places.length === 0) return;
      const options = {
        paddingTopLeft: L.point(48, 48 + inset.top),
        paddingBottomRight: L.point(48, 48 + inset.bottom),
        maxZoom: MAX_FIT_ZOOM,
        animate: !first,
      };
      map.fitBounds(L.latLngBounds(places.map((r) => [r.location.lat, r.location.lng])), options);
      if (map.getZoom() < MIN_FIT_ZOOM) map.setZoom(MIN_FIT_ZOOM, { animate: false });
    };
    if (first) {
      fit();
      return;
    }
    // Last user intent wins: moving the map by hand, or asking the list to
    // show a restaurant, before the delay ends cancels this fit for good (a
    // later change of results fits again).
    let stopWatching = () => {};
    const cancel = () => {
      clearTimeout(timer);
      stopWatching();
      fitted.current = fitKey;
      if (pendingRef.current === cancel) pendingRef.current = undefined;
    };
    const timer = setTimeout(() => {
      stopWatching();
      pendingRef.current = undefined;
      fit();
    }, FIT_DELAY_MS);
    stopWatching = onUserMove(map, cancel);
    pendingRef.current = cancel;
    return () => {
      // Unmounted or superseded by newer results: nothing runs later.
      clearTimeout(timer);
      stopWatching();
      if (pendingRef.current === cancel) pendingRef.current = undefined;
    };
  }, [map, fitKey, pendingRef]);
  return null;
}

/** Shows the selected restaurant when the list asks (request changes), above the overlays. */
function FocusSelected({
  restaurant,
  request,
  insets,
  pendingFitRef,
}: {
  restaurant?: Located;
  request: number;
  insets: Insets;
  pendingFitRef: RefObject<(() => void) | undefined>;
}) {
  const map = useMap();
  const handled = useRef(0);
  useEffect(() => {
    if (request === handled.current || !restaurant) return;
    handled.current = request;
    // The visitor asked for this restaurant: a pending fit must not move away from it.
    pendingFitRef.current?.();
    const zoom = Math.max(map.getZoom(), FOCUS_ZOOM);
    // Center the restaurant in the part of the map that overlays leave visible.
    const point = map
      .project([restaurant.location.lat, restaurant.location.lng], zoom)
      .add([0, (insets.bottom - insets.top) / 2]);
    map.setView(map.unproject(point, zoom), zoom);
  }, [map, request, restaurant, insets, pendingFitRef]);
  return null;
}
