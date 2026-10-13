import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect } from 'react';
import { Circle, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngValue } from '../../shared/submission';
import type { RestaurantCandidate } from '../lib/poi';
import { TILE_ATTRIBUTION, TILE_URL } from '../lib/tiles';

const icon = (className: string) =>
  L.divIcon({ className: `map-pin ${className}`, html: '<span></span>', iconSize: [32, 32] });
const icons = { normal: icon(''), selected: icon('is-selected'), manual: icon('is-manual') };

interface Props {
  /** Where the map is centered; changes pan the map. */
  view: { center: LatLngValue; zoom: number };
  candidates?: RestaurantCandidate[];
  selectedKey?: string;
  /** Search area shown as a circle. */
  searchArea?: { center: LatLngValue; radiusMeters: number };
  /** A manually placed restaurant marker. */
  marker?: LatLngValue;
  onMapClick?: (point: LatLngValue) => void;
  onMove?: (center: LatLngValue) => void;
  onSelect?: (candidate: RestaurantCandidate) => void;
  label: string;
  className?: string;
}

/** Leaflet map for choosing a restaurant: candidate markers, a search circle, and a manual marker. */
export default function PickerMap({
  view,
  candidates = [],
  selectedKey,
  searchArea,
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
      <FollowView view={view} />
      <Events onMapClick={onMapClick} onMove={onMove} />
      {searchArea && (
        <Circle
          center={[searchArea.center.lat, searchArea.center.lng]}
          radius={searchArea.radiusMeters}
          pathOptions={{ color: '#b4441f', weight: 1, fillOpacity: 0.06 }}
        />
      )}
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

function Events({ onMapClick, onMove }: Pick<Props, 'onMapClick' | 'onMove'>) {
  useMapEvents({
    click: (e) => onMapClick?.({ lat: e.latlng.lat, lng: e.latlng.lng }),
    // Only report where the map is; searching happens on deliberate actions.
    moveend: (e) => {
      const c = (e.target as L.Map).getCenter();
      onMove?.({ lat: c.lat, lng: c.lng });
    },
  });
  return null;
}
