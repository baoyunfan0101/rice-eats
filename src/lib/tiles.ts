// Map tiles shared by the browsing map and the submission picker.
// OpenStreetMap's volunteer-run tiles are fine for light traffic with attribution
// (https://operations.osmfoundation.org/policies/tiles/). Set VITE_TILE_URL and
// VITE_TILE_ATTRIBUTION at build time to switch to another provider.
export const TILE_URL =
  import.meta.env.VITE_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION =
  import.meta.env.VITE_TILE_ATTRIBUTION ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
