// Navigation links for map apps. Derived from coordinates or the address unless
// the restaurant data gives an explicit link (useful when a search would land
// on the wrong business).

import type { RestaurantSummary } from '../../shared/content/model';

type Place = Pick<RestaurantSummary, 'name' | 'address' | 'location' | 'links'>;

export function googleMapsUrl(r: Place): string | undefined {
  if (r.links.googleMaps) return r.links.googleMaps;
  const query = r.address
    ? `${r.name}, ${r.address}`
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
  const params = new URLSearchParams({ q: r.name });
  if (r.location) params.set('ll', `${r.location.lat},${r.location.lng}`);
  else params.set('address', r.address!);
  return `https://maps.apple.com/?${params.toString()}`;
}
