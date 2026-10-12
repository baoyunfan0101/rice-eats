import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { contentDevPlugin } from './scripts/content/vite-plugin.ts';
import { parseTallyForm } from './shared/submission.ts';
import { BASE_PATH, TALLY_FORM } from './site.config.ts';

// The website reads the submission form from import.meta.env.VITE_TALLY_FORM.
// A malformed setting fails here instead of deploying broken links.
const tallyForm = parseTallyForm(TALLY_FORM);
if (tallyForm.status === 'invalid') {
  throw new Error(
    `TALLY_FORM in site.config.ts is invalid (${tallyForm.reason}): "${tallyForm.value}". ` +
      'Use the published form link, e.g. https://tally.so/r/abc123, or leave it empty.',
  );
}
process.env.VITE_TALLY_FORM = TALLY_FORM;

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
