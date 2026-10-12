// Site-wide build settings shared by Vite, the content pipeline, and tests.

/** Public base path. GitHub Pages serves the project site under /rice-eats/. */
export const BASE_PATH = normalizeBase(process.env.BASE_PATH ?? '/rice-eats/');

/** Directory (under public/) that receives generated data and images. */
export const GENERATED_DIR = 'generated';

function normalizeBase(base: string): string {
  let result = base.startsWith('/') ? base : `/${base}`;
  if (!result.endsWith('/')) result += '/';
  return result;
}
