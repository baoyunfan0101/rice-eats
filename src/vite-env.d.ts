/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Map tile URL template; defaults to OpenStreetMap's standard tiles. */
  readonly VITE_TILE_URL?: string;
  /** HTML attribution required by the tile provider. */
  readonly VITE_TILE_ATTRIBUTION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
