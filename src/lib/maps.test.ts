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

  it('prefers coordinates over the address, whatever language the name is in', () => {
    const r = {
      ...place,
      name: '河粉小馆',
      address: '1 Main St',
      location: { lat: 29.7, lng: -95.4 },
    };
    expect(googleMapsUrl(r)).toBe('https://www.google.com/maps/search/?api=1&query=29.7%2C-95.4');
    expect(appleMapsUrl(r)).toBe(
      'https://maps.apple.com/?q=%E6%B2%B3%E7%B2%89%E5%B0%8F%E9%A6%86&ll=29.7%2C-95.4',
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
