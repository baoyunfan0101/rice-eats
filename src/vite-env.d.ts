/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Map tile URL template; defaults to OpenStreetMap's standard tiles. */
  readonly VITE_TILE_URL?: string;
  /** HTML attribution required by the tile provider. */
  readonly VITE_TILE_ATTRIBUTION?: string;
  /** Published Tally submission form, set from site.config.ts by vite.config.ts. */
  readonly VITE_TALLY_FORM?: string;
  /** Browser key for the Geoapify Places API (restaurant search on the submission page). */
  readonly VITE_GEOAPIFY_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
