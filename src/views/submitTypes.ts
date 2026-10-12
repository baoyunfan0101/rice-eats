import type { LatLngValue, SelectionMethod } from '../../shared/submission';

/** A restaurant chosen on the submission page, before it is turned into form context. */
export interface Selection {
  method: SelectionMethod;
  name: string;
  restaurantId?: string;
  address?: string;
  /** Only an explicitly selected restaurant location, never the device position. */
  location?: LatLngValue;
  poi?: { provider: string; id: string };
}
