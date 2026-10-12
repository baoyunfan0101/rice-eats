import { describe, expect, it } from 'vitest';
import { appleMapsUrl, googleMapsUrl } from './maps';

const place = { name: 'Pho Spot', links: {} };

describe('map links', () => {
  it('derives Google and Apple Maps links from the address', () => {
    const r = { ...place, address: '1 Main St, Houston, TX' };
    expect(googleMapsUrl(r)).toBe(
      'https://www.google.com/maps/search/?api=1&query=Pho%20Spot%2C%201%20Main%20St%2C%20Houston%2C%20TX',
    );
    expect(appleMapsUrl(r)).toBe(
      'https://maps.apple.com/?q=Pho+Spot&address=1+Main+St%2C+Houston%2C+TX',
    );
  });

  it('uses coordinates when there is no address (Apple Maps prefers them)', () => {
    const r = { ...place, location: { lat: 29.7, lng: -95.4 } };
    expect(googleMapsUrl(r)).toBe('https://www.google.com/maps/search/?api=1&query=29.7%2C-95.4');
    expect(appleMapsUrl({ ...r, address: '1 Main St' })).toBe(
      'https://maps.apple.com/?q=Pho+Spot&ll=29.7%2C-95.4',
    );
  });

  it('prefers explicit links and returns nothing without a location', () => {
    const links = {
      googleMaps: 'https://maps.app.goo.gl/x',
      appleMaps: 'https://maps.apple.com/?auid=1',
    };
    expect(googleMapsUrl({ ...place, links })).toBe(links.googleMaps);
    expect(appleMapsUrl({ ...place, links })).toBe(links.appleMaps);
    expect(googleMapsUrl(place)).toBeUndefined();
    expect(appleMapsUrl(place)).toBeUndefined();
  });
});
