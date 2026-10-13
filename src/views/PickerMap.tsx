import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect } from 'react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngValue } from '../../shared/submission';
import type { Bounds, RestaurantCandidate } from '../lib/poi';
import { TILE_ATTRIBUTION, TILE_URL } from '../lib/tiles';

const icon = (className: string) =>
  L.divIcon({ className: `map-pin ${className}`, html: '<span></span>', iconSize: [32, 32] });
const icons = { normal: icon(''), selected: icon('is-selected'), manual: icon('is-manual') };

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
      {candidates.map((c) => (
        <Marker
          key={c.key}
          position={[c.location.lat, c.location.lng]}
          icon={c.key === selectedKey ? icons.selected : icons.normal}
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
      ))}
      {marker && (
        <Marker
          position={[marker.lat, marker.lng]}
          icon={icons.manual}
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
