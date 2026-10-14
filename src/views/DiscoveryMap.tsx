import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import {
  RICE_CENTER,
  type ImageAsset,
  type LatLng,
  type RestaurantSummary,
} from '../../shared/content/model';
import { placeLabels, type LabelPlacement } from '../lib/labelLayout';
import { onUserMove } from '../lib/mapGestures';
import { pinIconOptions } from '../lib/pin';
import { TILE_ATTRIBUTION, TILE_URL } from '../lib/tiles';

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** The smallest rendition of a photo (from its srcset), for map thumbnails. */
export function smallestRendition(image: ImageAsset): string {
  const candidates = image.srcset
    .split(',')
    .map((entry) => entry.trim().split(/\s+/))
    .map(([url, w]) => ({ url: url!, width: Number.parseInt(w ?? '', 10) }))
    .filter((c) => c.url && Number.isFinite(c.width));
  candidates.sort((a, b) => a.width - b.width);
  return candidates[0]?.url ?? image.src;
}

/**
 * A pin (anchored at its tip, src/lib/pin.ts), with a label beside it when it
 * has a placement: the cover thumbnail and the restaurant name.
 */
function restaurantIcon(
  r: RestaurantSummary,
  state: { selected: boolean; hovered: boolean },
  label?: LabelPlacement,
): L.DivIcon {
  const thumb = r.cover
    ? `<img class="poi-thumb" src="${escapeHtml(smallestRendition(r.cover))}" alt="" draggable="false">`
    : '<span class="poi-thumb is-empty"></span>';
  const html = label
    ? `<span class="poi-label has-thumb${label.side === 'left' ? ' is-left' : ''}" style="max-width:${label.maxWidth}px;margin-top:${label.dy}px">${thumb}<span class="poi-name">${escapeHtml(r.name)}</span></span>`
    : '';
  const options = pinIconOptions(state.selected, html);
  return L.divIcon({
    ...options,
    className: `${options.className}${state.hovered ? ' is-hovered' : ''}`,
  });
}

/** Notes over the map (no locations, failed tiles). */
const NOTE = 'border-2 border-ink bg-cream px-2.5 py-1 text-xs font-semibold shadow-px-sm';

/** Fitting never zooms in closer than this (one restaurant), nor out further than MIN_FIT_ZOOM. */
const MAX_FIT_ZOOM = 15;
const MIN_FIT_ZOOM = 10;
/** Zoom used when the list asks to show one restaurant. */
const FOCUS_ZOOM = 16;
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
  /** The restaurant under the pointer in the list ('' for none): its pin is highlighted. */
  hovered?: string;
  /** Bumped when the list asks to show `selected` on the map. */
  focusRequest: number;
  /** A pin was clicked (or activated from the keyboard). */
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
  hovered = '',
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

  return (
    <div role="region" aria-label="餐厅地图" className="relative h-full w-full overflow-hidden">
      <MapContainer
        center={[RICE_CENTER.lat, RICE_CENTER.lng]}
        zoom={13}
        className="h-full w-full bg-sand"
      >
        <TileLayer
          url={TILE_URL}
          attribution={TILE_ATTRIBUTION}
          maxZoom={19}
          eventHandlers={{ tileerror: () => setTilesFailed(true) }}
        />
        <FocusWithoutScrolling />
        <KeepSize />
        {/* Before the fit and the focus, so its labels follow their first moves too. */}
        <RestaurantMarkers
          located={located}
          selected={selected}
          hovered={hovered}
          onSelect={onSelect}
        />
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
      </MapContainer>

      <div
        className="pointer-events-none absolute right-3 left-3 z-[1000] flex flex-col items-end gap-2"
        style={{ top: insets.top + 12 }}
      >
        {located.length === 0 && restaurants.length > 0 && (
          <p role="status" className={`${NOTE} text-muted`}>
            当前结果都没有位置信息
          </p>
        )}
        {missing > 0 && located.length > 0 && (
          <p className={`${NOTE} text-muted`}>{missing} 家餐厅暂无位置信息，未在地图上显示</p>
        )}
        {tilesFailed && (
          <p role="status" className={`${NOTE} text-chili-700`}>
            部分地图底图加载失败，标记位置仍然有效
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Restaurant pins, each labelled with its cover thumbnail and name when there
 * is room: `placeLabels` decides which and on which side (the selected one
 * always, then the best rated, without overlaps, covered pins, or labels cut
 * off by the map edge). Pins without room keep their name as a tooltip, and
 * zooming in makes room. The layout follows pans, zooms, and resizes.
 */
function RestaurantMarkers({
  located,
  selected,
  hovered,
  onSelect,
}: {
  located: Located[];
  selected: string;
  hovered: string;
  onSelect: (id: string) => void;
}) {
  const map = useMap();
  const [layout, setLayout] = useState(0);
  const relayout = () => setLayout((n) => n + 1);
  useMapEvents({ zoomend: relayout, moveend: relayout, resize: relayout });

  const labels = useMemo(() => {
    void layout; // recompute when the map moves
    const size = map.getSize();
    return placeLabels(
      located.map((r) => {
        const p = map.latLngToContainerPoint([r.location.lat, r.location.lng]);
        return {
          key: r.id,
          x: p.x,
          y: p.y,
          name: r.name,
          selected: r.id === selected,
          thumb: true,
          priority: r.rating ?? 0,
        };
      }),
      { width: size.x, height: size.y },
    );
  }, [located, selected, map, layout]);

  return located.map((r) => {
    const isSelected = r.id === selected;
    const isHovered = r.id === hovered && !isSelected;
    const label = labels.get(r.id);
    return (
      <Marker
        key={r.id}
        position={[r.location.lat, r.location.lng]}
        icon={restaurantIcon(r, { selected: isSelected, hovered: isHovered }, label)}
        title={r.name}
        alt={r.name}
        zIndexOffset={isSelected ? 1000 : isHovered ? 900 : label ? 100 : 0}
        eventHandlers={{
          click: () => onSelect(r.id),
          // Leaflet makes markers focusable but does not activate them from the keyboard.
          keypress: (e) => {
            const key = (e as L.LeafletKeyboardEvent).originalEvent.key;
            if (key === 'Enter' || key === ' ') onSelect(r.id);
          },
        }}
      />
    );
  });
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
