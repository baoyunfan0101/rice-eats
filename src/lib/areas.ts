// Search areas for the submission page: where the map looks for restaurants
// (or where a manually added restaurant is placed). An area is a map center
// and zoom with a readable name; it is never a restaurant's location.

import { RICE_CENTER } from '../../shared/content/model';
import type { LatLngValue } from '../../shared/submission';
import { distanceMeters } from './poi';

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

/**
 * How far (meters) the map center may move from an area's center and still
 * count as that area; beyond it, the page calls it the map's current position.
 */
export const AREA_RADIUS = 1200;

/** The name of the area the map is showing: the chosen area while the map is still near it. */
export function currentAreaLabel(area: SearchArea | undefined, mapCenter: LatLngValue): string {
  return area && distanceMeters(area.center, mapCenter) <= AREA_RADIUS
    ? area.label
    : '地图当前位置附近';
}
