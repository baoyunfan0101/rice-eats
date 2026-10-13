// Navigation links for map apps. Verified coordinates come first, because they
// pick the right place whatever language the restaurant name is in; the
// address is the fallback. An explicit link in the restaurant data overrides
// both (useful when the derived destination lands on the wrong business).

import type { RestaurantSummary } from '../../shared/content/model';

type Place = Pick<RestaurantSummary, 'name' | 'address' | 'location' | 'links'>;

export function googleMapsUrl(r: Place): string | undefined {
  if (r.links.googleMaps) return r.links.googleMaps;
  const query = r.location
    ? `${r.location.lat},${r.location.lng}`
    : r.address
      ? `${r.name}, ${r.address}`
      : undefined;
  return query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : undefined;
}

export function appleMapsUrl(r: Place): string | undefined {
  if (r.links.appleMaps) return r.links.appleMaps;
  if (!r.location && !r.address) return undefined;
  // q is only the label shown on the pin; ll (or address) decides the place.
  const params = new URLSearchParams({ q: r.name });
  if (r.location) params.set('ll', `${r.location.lat},${r.location.lng}`);
  else params.set('address', r.address!);
  return `https://maps.apple.com/?${params.toString()}`;
}
