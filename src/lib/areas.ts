// Map shortcuts for the submission page: where the map looks for restaurants
// (or where a manually added restaurant is placed). An area is a map center
// and zoom with a readable name; it is never a restaurant's location.

import { RICE_CENTER } from '../../shared/content/model';
import { isValidLatLng, type LatLngValue } from '../../shared/submission';

export interface SearchArea {
  label: string;
  center: LatLngValue;
  zoom: number;
}

/** Preset areas: static coordinates, no request needed. */
export const PRESET_AREAS = {
  rice: { label: 'Rice University 周边', center: RICE_CENTER, zoom: 15 },
  // Houston's Chinatown along Bellaire Blvd in the southwest (between Dun
  // Huang Plaza and Hong Kong City Mall), not the old Downtown Chinatown.
  chinatown: { label: 'Chinatown 周边', center: { lat: 29.704, lng: -95.556 }, zoom: 15 },
} as const satisfies Record<string, SearchArea>;

/** Zoom used for the current location and for searched places. */
export const PLACE_ZOOM = 16;

/** Where the contributor last found a restaurant, kept only in this browser. */
const LAST_AREA_KEY = 'rice-eats:last-area';

/**
 * The "上次的位置" area: the map view when the contributor last went on to
 * the form, stored only in this browser's localStorage (never sent
 * anywhere), rounded to about 100 m. Undefined when there is none or storage
 * is unavailable.
 */
export function loadLastArea(): SearchArea | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_AREA_KEY) ?? 'null') as Partial<
      LatLngValue & { zoom: number }
    > | null;
    const center = v && { lat: Number(v.lat), lng: Number(v.lng) };
    if (!center || !isValidLatLng(center) || typeof v.zoom !== 'number') return undefined;
    return { label: '上次的位置', center, zoom: v.zoom };
  } catch {
    return undefined;
  }
}

export function saveLastArea(view: { center: LatLngValue; zoom: number }) {
  try {
    const round = (n: number) => Math.round(n * 1000) / 1000;
    localStorage.setItem(
      LAST_AREA_KEY,
      JSON.stringify({
        lat: round(view.center.lat),
        lng: round(view.center.lng),
        zoom: Math.round(view.zoom),
      }),
    );
  } catch {
    // Storage unavailable (private window, blocked): nothing is remembered.
  }
}
