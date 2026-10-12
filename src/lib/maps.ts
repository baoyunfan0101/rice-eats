// Navigation links for map apps. Derived from coordinates or the address unless
// the restaurant data gives an explicit link (useful when a search would land
// on the wrong business).

import type { RestaurantSummary } from '../../shared/content/model';

type Place = Pick<RestaurantSummary, 'name' | 'nameEn' | 'address' | 'location' | 'links'>;

// Map apps index businesses mostly under their English names.
const searchName = (r: Place) => r.nameEn ?? r.name;

export function googleMapsUrl(r: Place): string | undefined {
  if (r.links.googleMaps) return r.links.googleMaps;
  const query = r.address
    ? `${searchName(r)}, ${r.address}`
    : r.location
      ? `${r.location.lat},${r.location.lng}`
      : undefined;
  return query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : undefined;
}

export function appleMapsUrl(r: Place): string | undefined {
  if (r.links.appleMaps) return r.links.appleMaps;
  if (!r.location && !r.address) return undefined;
  const params = new URLSearchParams({ q: searchName(r) });
  if (r.location) params.set('ll', `${r.location.lat},${r.location.lng}`);
  else params.set('address', r.address!);
  return `https://maps.apple.com/?${params.toString()}`;
}
