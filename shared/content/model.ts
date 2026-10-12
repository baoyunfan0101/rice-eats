// Data contract for generated website data: the build pipeline
// (scripts/content) writes these shapes into public/generated/, and the website
// reads them. Framework-independent; imports nothing from src/ or scripts/.

import type { Rating, Verdict } from './vocabulary';

export type { Rating, Verdict };

export type PublicationStatus = 'draft' | 'published';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface ImageAsset {
  /** Absolute URL (including the site base path) of a mid-size rendition. */
  src: string;
  /** `srcset` value listing every generated width. */
  srcset: string;
  /** Intrinsic size of the largest rendition; used to reserve layout space. */
  width: number;
  height: number;
  alt: string;
}

/** Public contributor identity. Contact details are never part of generated data. */
export interface Contributor {
  id: string;
  name: string;
}

export interface Dish {
  name: string;
  verdict?: Verdict;
  comment?: string;
  /** Index into RestaurantDetail.images of the dish's photo, if any. */
  imageIndex?: number;
}

/** Optional explicit map links; otherwise the site derives them from location or address. */
export interface MapLinks {
  googleMaps?: string;
  appleMaps?: string;
  website?: string;
}

export interface RestaurantSummary {
  id: string;
  status: PublicationStatus;
  /** Display name: nameZh when present, otherwise nameEn. */
  name: string;
  nameZh?: string;
  nameEn?: string;
  altNames: string[];
  /** Cuisine keys (see vocabulary.ts). */
  cuisines: string[];
  /** Tag keys (see vocabulary.ts). */
  tags: string[];
  address?: string;
  location?: LatLng;
  rating?: Rating;
  pricePerPerson?: number;
  /** The first image of the restaurant, if any. */
  cover?: ImageAsset;
  links: MapLinks;
}

export interface RestaurantDetail extends RestaurantSummary {
  /** Every image of the restaurant in its stored order; images[0] is the cover. */
  images: ImageAsset[];
  dishes: Dish[];
  /** Sanitized HTML rendered from review.md. Empty when there is no review. */
  reviewHtml: string;
  /** Indexes into `images` of the photos placed in review.md (each listed once). */
  reviewImageIndexes: number[];
  contributors: Contributor[];
}

export type ContentSource = 'content' | 'fixtures';

export interface ContentIndex {
  source: ContentSource;
  includesDrafts: boolean;
  restaurants: RestaurantSummary[];
}

/** Rice University main quad; the map centers here and coordinates are checked against it. */
export const RICE_CENTER: LatLng = { lat: 29.7174, lng: -95.4018 };

export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
