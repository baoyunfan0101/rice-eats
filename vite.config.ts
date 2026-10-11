import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { contentDevPlugin } from './scripts/content/vite-plugin.ts';
import { BASE_PATH } from './site.config.ts';

export default defineConfig({
  base: BASE_PATH,
  // The manifest lets scripts/postbuild.ts allowlist exactly the files Vite emitted.
  build: { manifest: true },
  plugins: [react(), tailwindcss(), contentDevPlugin()],
  server: {
    watch: { ignored: ['**/public/generated/**', '**/.cache/**'] },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/unit/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    testTimeout: 30_000,
  },
});
