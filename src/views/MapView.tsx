import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import { RICE_CENTER, type LatLng, type RestaurantSummary } from '../content/model';
import { RatingBadge } from '../components/Badges';
import { Link } from '../components/Link';
import { RestaurantImage } from '../components/RestaurantImage';
import { metaLine } from '../lib/format';
import { restaurantHref } from '../lib/router';

// OpenStreetMap's volunteer-run tiles are fine for light traffic with attribution
// (https://operations.osmfoundation.org/policies/tiles/). Set VITE_TILE_URL and
// VITE_TILE_ATTRIBUTION at build time to switch to another provider.
const TILE_URL = import.meta.env.VITE_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  import.meta.env.VITE_TILE_ATTRIBUTION ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const pinIcons = {
  normal: L.divIcon({ className: 'map-pin', html: '<span></span>', iconSize: [32, 32] }),
  selected: L.divIcon({
    className: 'map-pin is-selected',
    html: '<span></span>',
    iconSize: [32, 32],
  }),
};

interface Props {
  restaurants: RestaurantSummary[];
  selected: string;
  onSelect: (id: string) => void;
}

type Located = RestaurantSummary & { location: LatLng };

export default function MapView({ restaurants, selected, onSelect }: Props) {
  const located = useMemo(
    () => restaurants.filter((r): r is Located => r.location !== undefined),
    [restaurants],
  );
  const missing = restaurants.length - located.length;
  const current = restaurants.find((r) => r.id === selected);
  const [tilesFailed, setTilesFailed] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useFillViewport(mapRef);
  useFillViewport(listRef);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 gap-4 lg:px-4 lg:py-4">
      <aside className="hidden w-80 shrink-0 lg:block" aria-label="地图上的餐厅">
        <ul ref={listRef} className="min-h-[420px] space-y-1 overflow-y-auto pr-1">
          {restaurants.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                aria-pressed={r.id === selected}
                className="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-white aria-pressed:bg-white aria-pressed:ring-2 aria-pressed:ring-chili-600"
              >
                <RestaurantImage
                  decorative
                  image={r.cover}
                  sizes="56px"
                  className="size-14 shrink-0 rounded-lg"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-semibold">{r.name}</span>
                    <RatingBadge rating={r.rating} />
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {r.location ? metaLine(r) : '暂无位置信息'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div
        ref={mapRef}
        className="relative min-h-[420px] flex-1 overflow-hidden lg:rounded-2xl lg:border lg:border-line"
      >
        <MapContainer
          center={[RICE_CENTER.lat, RICE_CENTER.lng]}
          zoom={13}
          className="h-full w-full bg-line"
          aria-label="餐厅地图"
        >
          <TileLayer
            url={TILE_URL}
            attribution={TILE_ATTRIBUTION}
            maxZoom={19}
            eventHandlers={{ tileerror: () => setTilesFailed(true) }}
          />
          <FocusWithoutScrolling />
          <FitToRestaurants located={located} />
          <PanToSelected restaurant={current?.location ? (current as Located) : undefined} />
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

        <div className="pointer-events-none absolute top-3 right-3 left-3 z-[1000] flex flex-col items-end gap-2">
          {missing > 0 && (
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

        {current && <Preview restaurant={current} onClose={() => onSelect('')} />}
      </div>
    </div>
  );
}

function Preview({
  restaurant: r,
  onClose,
}: {
  restaurant: RestaurantSummary;
  onClose: () => void;
}) {
  return (
    <section
      aria-label={`${r.name} 预览`}
      className="absolute right-3 bottom-6 left-3 z-[1000] mx-auto flex max-w-md gap-3 rounded-2xl bg-white p-3 shadow-xl sm:right-auto sm:left-4 sm:w-96"
    >
      <RestaurantImage
        decorative
        image={r.cover}
        sizes="112px"
        className="aspect-square w-24 shrink-0 rounded-xl sm:w-28"
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

/**
 * Sizes an element to reach the bottom of the viewport from where it starts, so
 * the map (and its preview card) fits on screen whatever is above it
 * (header, notices, toolbar). The bottom margin leaves room on wide screens.
 */
function useFillViewport(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      const margin = window.matchMedia('(min-width: 1024px)').matches ? 16 : 0;
      element.style.height = `${Math.max(420, window.innerHeight - top - margin)}px`;
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [ref]);
}

/** Fits the map to the filtered restaurants whenever the filter result changes. */
function FitToRestaurants({ located }: { located: Located[] }) {
  const map = useMap();
  const key = located.map((r) => r.id).join(',');
  const first = useRef(true);
  useEffect(() => {
    const animate = !first.current;
    first.current = false;
    if (located.length === 0) {
      map.setView([RICE_CENTER.lat, RICE_CENTER.lng], 13, { animate });
    } else if (located.length === 1) {
      map.setView([located[0]!.location.lat, located[0]!.location.lng], 15, { animate });
    } else {
      map.fitBounds(L.latLngBounds(located.map((r) => [r.location.lat, r.location.lng])), {
        padding: [48, 48],
        maxZoom: 15,
        animate,
      });
    }
    // Refit only when the set of restaurants changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

/** Brings the selected restaurant into view if it is off screen. */
function PanToSelected({ restaurant }: { restaurant?: Located }) {
  const map = useMap();
  const lat = restaurant?.location.lat;
  const lng = restaurant?.location.lng;
  useEffect(() => {
    if (lat === undefined || lng === undefined) return;
    if (!map.getBounds().pad(-0.15).contains([lat, lng])) map.panTo([lat, lng]);
  }, [map, lat, lng]);
  return null;
}
