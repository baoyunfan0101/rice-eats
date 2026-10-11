import path from 'node:path';
import { GENERATED_DIR } from '../../site.config.ts';
import type { ContentSource } from '../../src/content/model.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');

/** Canonical, public database (content/) and the fictional fixture database. */
export const DATABASES: Record<ContentSource, { restaurants: string; contributors: string }> = {
  content: {
    restaurants: path.join(ROOT, 'content', 'restaurants'),
    contributors: path.join(ROOT, 'content', 'contributors.json'),
  },
  fixtures: {
    restaurants: path.join(ROOT, 'fixtures', 'restaurants'),
    contributors: path.join(ROOT, 'fixtures', 'contributors.json'),
  },
};
export const RESTAURANT_DIRS: Record<ContentSource, string> = {
  content: DATABASES.content.restaurants,
  fixtures: DATABASES.fixtures.restaurants,
};

/** Git-ignored working area: nothing in here is ever committed or deployed. */
export const PRIVATE_DIR = path.join(ROOT, 'private');
/** Drafts that are not yet approved for the public repository. */
export const DRAFTS_DIR = path.join(PRIVATE_DIR, 'drafts');
/** Contributors' raw submissions (text, documents, original photos). */
export const SUBMISSIONS_DIR = path.join(PRIVATE_DIR, 'submissions');
/** Pending contributors and contact details. */
export const PRIVATE_CONTRIBUTORS = path.join(PRIVATE_DIR, 'contributors.json');

export const OUT_DIR = path.join(ROOT, 'public', GENERATED_DIR);
export const IMAGE_CACHE_DIR = path.join(ROOT, '.cache', 'images');

export function sourceFromEnv(): ContentSource {
  const value = process.env.RICE_EATS_SOURCE ?? 'content';
  if (value !== 'content' && value !== 'fixtures') {
    throw new Error(`RICE_EATS_SOURCE must be "content" or "fixtures", got "${value}"`);
  }
  return value;
}

export function draftsFromEnv(): boolean {
  return process.env.RICE_EATS_DRAFTS === '1';
}
