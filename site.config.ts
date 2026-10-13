// Site-wide build settings shared by Vite, the content pipeline, and tests.

/** Public base path. GitHub Pages serves the project site under /rice-eats/. */
export const BASE_PATH = normalizeBase(process.env.BASE_PATH ?? '/rice-eats/');

/**
 * Published Tally submission form (docs/submissions.md), e.g.
 * "https://tally.so/r/abc123". When empty, the website hides its submission
 * links. The TALLY_FORM environment variable overrides it (used by tests).
 */
export const TALLY_FORM = process.env.TALLY_FORM ?? 'https://tally.so/r/obrKlP';

/** Directory (under public/) that receives generated data and images. */
export const GENERATED_DIR = 'generated';

function normalizeBase(base: string): string {
  let result = base.startsWith('/') ? base : `/${base}`;
  if (!result.endsWith('/')) result += '/';
  return result;
}
