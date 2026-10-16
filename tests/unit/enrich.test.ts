import { describe, expect, it } from 'vitest';
import { compareAddresses, verifyListing, type PoiDetails } from '../../scripts/content/enrich.ts';

// Whether a map listing (from an unverified POI id) is the intended
// restaurant. All places are fictional.

const listing = (extra: Partial<PoiDetails>): PoiDetails => ({
  key: 'osm:node/1',
  status: 'ok',
  fetchedAt: '2026-10-15T00:00:00Z',
  names: [],
  facts: [],
  unmappedCuisines: [],
  ...extra,
});
const HERE = { lat: 29.7174, lng: -95.4018 };
const expected = {
  names: ['示例汤包馆'],
  location: HERE,
  address: '6100 Main St, Houston, TX 77005',
};

describe('map listing identity', () => {
  it('compares addresses by house number, street, and unit', () => {
    expect(compareAddresses('6100 Main Street, Houston', '6100 Main St, Houston, TX 77005')).toBe(
      'agree',
    );
    expect(compareAddresses('6102 Main St', '6100 Main St')).toBe('disagree');
    expect(compareAddresses('6100 Kirby Dr', '6100 Main St')).toBe('disagree');
    expect(compareAddresses('2400 Times Blvd Suite 110', '2400 Times Blvd Ste 120')).toBe(
      'disagree',
    );
    expect(compareAddresses('Rice Village', '6100 Main St')).toBe('unknown');
    expect(compareAddresses(undefined, '6100 Main St')).toBe('unknown');
  });

  it('verifies the same name at the same place, also in another language among its names', () => {
    expect(
      verifyListing(listing({ names: ['示例汤包馆'], location: HERE }), expected).verdict,
    ).toBe('verified');
    expect(
      verifyListing(
        listing({
          names: ['Example Dumpling House', '示例汤包馆'],
          location: { lat: 29.7176, lng: -95.4018 },
        }),
        expected,
      ).verdict,
    ).toBe('verified');
    // A longer listing name that contains the restaurant's name.
    expect(
      verifyListing(listing({ names: ['Example Dumpling House - Rice Village'], location: HERE }), {
        ...expected,
        names: ['Example Dumpling House'],
      }).verdict,
    ).toBe('verified');
  });

  it('verifies another-language name only at the same spot with the same address', () => {
    const english = listing({
      names: ['Example Dumpling House'],
      location: HERE,
      address: '6100 Main Street, Houston',
    });
    expect(verifyListing(english, expected).verdict).toBe('verified');
    expect(verifyListing({ ...english, address: undefined }, expected).verdict).toBe('ambiguous');
    expect(verifyListing({ ...english, address: '6120 Main Street' }, expected).verdict).toBe(
      'rejected',
    );
  });

  it('rejects another branch of a chain and another restaurant', () => {
    const branch = verifyListing(
      listing({ names: ['示例汤包馆'], location: { lat: 29.76, lng: -95.36 } }),
      expected,
    );
    expect(branch.verdict).toBe('rejected');
    expect(branch.reasons.join('; ')).toMatch(/another branch/);
    expect(
      verifyListing(
        listing({ names: ['Other Noodle Bar'], location: { lat: 29.7183, lng: -95.4018 } }),
        expected,
      ).verdict,
    ).toBe('rejected');
  });

  it('leaves listings without enough evidence to the maintainer', () => {
    // No coordinates: a name alone (chains share names) is not enough.
    expect(verifyListing(listing({ names: ['示例汤包馆'] }), expected).verdict).toBe('ambiguous');
    // ...but the same name and address are.
    expect(
      verifyListing(listing({ names: ['示例汤包馆'], address: '6100 Main St' }), expected).verdict,
    ).toBe('verified');
    // A manual restaurant without a location.
    expect(
      verifyListing(listing({ names: ['示例汤包馆'], location: HERE }), { names: ['示例汤包馆'] })
        .verdict,
    ).toBe('ambiguous');
    // Same name nearby but the address differs.
    expect(
      verifyListing(
        listing({ names: ['示例汤包馆'], location: HERE, address: '6200 Main St' }),
        expected,
      ).verdict,
    ).toBe('ambiguous');
    // No name at all.
    expect(verifyListing(listing({ location: HERE }), expected).verdict).toBe('ambiguous');
  });
});
