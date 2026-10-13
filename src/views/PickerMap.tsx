import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngValue } from '../../shared/submission';
import type { Bounds, RestaurantCandidate } from '../lib/poi';
import { TILE_ATTRIBUTION, TILE_URL } from '../lib/tiles';

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** A pin with the restaurant name beside it (names come from POI data: escaped). */
function poiIcon(name: string | undefined, selected: boolean): L.DivIcon {
  const label = name ? `<span class="poi-label">${escapeHtml(name)}</span>` : '';
  return L.divIcon({
    className: `poi-marker${selected ? ' is-selected' : ''}`,
    html: `<span class="poi-pin" aria-hidden="true"></span>${label}`,
    // The anchor is the tip of the pin.
    iconSize: selected ? [32, 40] : [24, 30],
    iconAnchor: selected ? [16, 40] : [12, 30],
  });
}
const manualIcon = L.divIcon({
  className: 'map-pin is-manual',
  html: '<span></span>',
  iconSize: [32, 32],
});

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
  /** A manually placed restaurant marker. */
  marker?: LatLngValue;
  onMapClick?: (point: LatLngValue) => void;
  /** The visible area, reported when the map is ready and after every pan or zoom. */
  onMove?: (area: MapArea) => void;
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
  onMapClick,
  onMove,
  onSelect,
  label,
  className = 'h-72 sm:h-96',
}: Props) {
  return (
    <MapContainer
      center={[view.center.lat, view.center.lng]}
      zoom={view.zoom}
      className={`${className} w-full rounded-2xl border border-line bg-line`}
    >
      <Container label={label} />
      <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />
      {/* Events first: its handlers must be attached before FollowView moves the map. */}
      <Events onMapClick={onMapClick} onMove={onMove} />
      <FollowView view={view} />
      <CandidateMarkers candidates={candidates} selectedKey={selectedKey} onSelect={onSelect} />
      {marker && (
        <Marker
          position={[marker.lat, marker.lng]}
          icon={manualIcon}
          title="餐厅位置"
          alt="餐厅位置"
          keyboard={false}
        />
      )}
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

/** Approximate label box in pixels, relative to the pin tip. */
const LABEL_HEIGHT = 22;
const labelWidth = (name: string) => {
  let units = 0;
  for (const ch of name) units += /[\u2E80-\uFFFF]/.test(ch) ? 2 : 1.1;
  return Math.min(176, units * 6.5 + 14);
};

/**
 * Restaurant pins with their names. Names are placed greedily so they do not
 * overlap: the selected restaurant first, then the ones nearest the map
 * center; a name that would overlap one already placed is left out (its pin
 * stays, and the name shows as the map is zoomed in).
 */
function CandidateMarkers({
  candidates,
  selectedKey,
  onSelect,
}: Pick<Props, 'selectedKey' | 'onSelect'> & { candidates: RestaurantCandidate[] }) {
  const map = useMap();
  const [layout, setLayout] = useState(0);
  useMapEvents({ zoomend: () => setLayout((n) => n + 1), moveend: () => setLayout((n) => n + 1) });

  const labeled = useMemo(() => {
    void layout; // recompute when the map moves
    const size = map.getSize();
    const center = L.point(size.x / 2, size.y / 2);
    const placed: L.Bounds[] = [];
    const shown = new Set<string>();
    const ordered = candidates
      .map((c) => ({ c, p: map.latLngToContainerPoint([c.location.lat, c.location.lng]) }))
      .sort(
        (a, b) =>
          Number(b.c.key === selectedKey) - Number(a.c.key === selectedKey) ||
          a.p.distanceTo(center) - b.p.distanceTo(center),
      );
    for (const { c, p } of ordered) {
      const top = p.y - (c.key === selectedKey ? 34 : 26);
      const box = L.bounds([p.x + 10, top], [p.x + 14 + labelWidth(c.name), top + LABEL_HEIGHT]);
      if (c.key !== selectedKey && placed.some((b) => b.intersects(box))) continue;
      placed.push(box);
      shown.add(c.key);
    }
    return shown;
  }, [candidates, selectedKey, map, layout]);

  return candidates.map((c) => {
    const selected = c.key === selectedKey;
    return (
      <Marker
        key={c.key}
        position={[c.location.lat, c.location.lng]}
        icon={poiIcon(labeled.has(c.key) ? c.name : undefined, selected)}
        zIndexOffset={selected ? 1000 : labeled.has(c.key) ? 100 : 0}
        title={c.name}
        alt={c.name}
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
}

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
