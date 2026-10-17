import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngValue } from '../../shared/submission';
import { placeLabels, type LabelPlacement } from '../lib/labelLayout';
import { onUserMove } from '../lib/mapGestures';
import { pinIconOptions } from '../lib/pin';
import type { Bounds, RestaurantCandidate } from '../lib/poi';
import { TILE_ATTRIBUTION, TILE_URL } from '../lib/tiles';

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * A pin, with the restaurant name beside it when it has a label placement
 * (names come from POI data: escaped). The anchor is the tip of the pin
 * (src/lib/pin.ts).
 */
function poiIcon(
  name: string,
  selected: boolean,
  label?: LabelPlacement,
  listed = false,
): L.DivIcon {
  const html = label
    ? `<span class="poi-label${label.side === 'left' ? ' is-left' : ''}" style="max-width:${label.maxWidth}px;margin-top:${label.dy}px">${escapeHtml(name)}</span>`
    : '';
  return L.divIcon(pinIconOptions(selected, html, listed));
}

export interface MapArea {
  center: LatLngValue;
  bounds: Bounds;
  zoom: number;
}

interface Props {
  /** Where the map is centered; changes pan the map. */
  view: { center: LatLngValue; zoom: number };
  candidates?: RestaurantCandidate[];
  selectedKey?: string;
  /** A manually placed restaurant marker, drawn like a selected restaurant. */
  marker?: LatLngValue;
  /** The name beside the manual marker. */
  markerLabel?: string;
  onMapClick?: (point: LatLngValue) => void;
  /** The visible area, reported when the map is ready and after every pan or zoom. */
  onMove?: (area: MapArea) => void;
  /**
   * The contributor starts moving the map by hand (drag, wheel, pinch, double
   * click, zoom buttons, or keyboard), as opposed to a programmatic setView.
   */
  onUserMove?: () => void;
  onSelect?: (candidate: RestaurantCandidate) => void;
  label: string;
  className?: string;
}

/** Leaflet map for choosing a restaurant: candidate markers and a manual marker. */
export default function PickerMap({
  view,
  candidates = [],
  selectedKey,
  marker,
  markerLabel = '餐厅位置',
  onMapClick,
  onMove,
  onUserMove,
  onSelect,
  label,
  className = 'h-72 sm:h-96',
}: Props) {
  const manual = useMemo(
    () => marker && { location: marker, name: markerLabel },
    [marker, markerLabel],
  );
  return (
    <MapContainer
      center={[view.center.lat, view.center.lng]}
      zoom={view.zoom}
      className={`${className} w-full border-2 border-ink bg-sand`}
    >
      <Container label={label} />
      <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />
      {/* Events first: its handlers must be attached before FollowView moves the map. */}
      <Events onMapClick={onMapClick} onMove={onMove} />
      {onUserMove && <UserMoves onUserMove={onUserMove} />}
      <FollowView view={view} />
      <CandidateMarkers
        candidates={candidates}
        selectedKey={selectedKey}
        onSelect={onSelect}
        manual={manual}
      />
    </MapContainer>
  );
}

/**
 * Names the map for assistive technology, and keeps Leaflet's focus-on-press
 * from scrolling the page on small screens (so taps land where intended).
 */
function Container({ label }: { label: string }) {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', label);
    const focus = container.focus.bind(container);
    container.focus = (options?: FocusOptions) => focus({ ...options, preventScroll: true });
  }, [map, label]);
  return null;
}

/**
 * Restaurant pins with their names. `placeLabels` decides which pins are
 * named and on which side: the selected restaurant always, the others nearest
 * the map center first, without overlaps, covered pins, or names cut off by
 * the map edge. Pins without room keep their name as a tooltip and appear in
 * the list below the map. A manual marker is laid out the same way, as a
 * selected pin. The layout follows pans, zooms, resizes, new candidates, and
 * a moved or renamed manual marker.
 */
function CandidateMarkers({
  candidates,
  selectedKey,
  onSelect,
  manual,
}: Pick<Props, 'selectedKey' | 'onSelect'> & {
  candidates: RestaurantCandidate[];
  manual?: { location: LatLngValue; name: string };
}) {
  const map = useMap();
  const [layout, setLayout] = useState(0);
  const relayout = () => setLayout((n) => n + 1);
  useMapEvents({ zoomend: relayout, moveend: relayout, resize: relayout });

  const labels = useMemo(() => {
    void layout; // recompute when the map moves
    const size = map.getSize();
    const pin = (key: string, location: LatLngValue, name: string, selected: boolean) => {
      const p = map.latLngToContainerPoint([location.lat, location.lng]);
      return { key, x: p.x, y: p.y, name, selected };
    };
    return placeLabels(
      [
        ...candidates.map((c) => pin(c.key, c.location, c.name, c.key === selectedKey)),
        ...(manual ? [pin(MANUAL_KEY, manual.location, manual.name, true)] : []),
      ],
      { width: size.x, height: size.y },
    );
  }, [candidates, selectedKey, manual, map, layout]);

  const markers = candidates.map((c) => {
    const selected = c.key === selectedKey;
    const label = labels.get(c.key);
    return (
      <Marker
        key={c.key}
        position={[c.location.lat, c.location.lng]}
        icon={poiIcon(c.name, selected, label, !!c.restaurantId)}
        zIndexOffset={selected ? 1000 : label ? 100 : 0}
        title={c.restaurantId ? `${c.name}（已收录）` : c.name}
        alt={c.restaurantId ? `${c.name}（已收录）` : c.name}
        eventHandlers={{
          click: () => onSelect?.(c),
          keypress: (e) => {
            const key = (e as L.LeafletKeyboardEvent).originalEvent.key;
            if (key === 'Enter' || key === ' ') onSelect?.(c);
          },
        }}
      />
    );
  });
  if (manual) {
    markers.push(
      <Marker
        key={MANUAL_KEY}
        position={[manual.location.lat, manual.location.lng]}
        icon={poiIcon(manual.name, true, labels.get(MANUAL_KEY))}
        zIndexOffset={1000}
        title="餐厅位置"
        alt="餐厅位置"
        keyboard={false}
      />,
    );
  }
  return markers;
}

/** Layout key of the manual marker (never a candidate key, which has a provider prefix). */
const MANUAL_KEY = 'manual:marker';

function FollowView({ view }: { view: Props['view'] }) {
  const map = useMap();
  useEffect(() => {
    map.setView([view.center.lat, view.center.lng], view.zoom);
  }, [map, view]);
  return null;
}

const areaOf = (map: L.Map): MapArea => {
  const c = map.getCenter();
  const b = map.getBounds();
  return {
    center: { lat: c.lat, lng: c.lng },
    bounds: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() },
    zoom: map.getZoom(),
  };
};

/** Reports the start of a move by the contributor (see mapGestures.ts). */
function UserMoves({ onUserMove: report }: { onUserMove: () => void }) {
  const map = useMap();
  const latest = useRef(report);
  useEffect(() => {
    latest.current = report;
  }, [report]);
  useEffect(() => onUserMove(map, () => latest.current()), [map]);
  return null;
}

function Events({ onMapClick, onMove }: Pick<Props, 'onMapClick' | 'onMove'>) {
  const map = useMapEvents({
    click: (e) => onMapClick?.({ lat: e.latlng.lat, lng: e.latlng.lng }),
    moveend: () => onMove?.(areaOf(map)),
  });
  // The first area, once the map has its size.
  useEffect(() => {
    if (!onMove) return;
    map.whenReady(() => onMove(areaOf(map)));
    // Only once per map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
  return null;
}
