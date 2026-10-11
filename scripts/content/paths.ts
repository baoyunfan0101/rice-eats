import path from 'node:path';
import { GENERATED_DIR } from '../../site.config.ts';
import type { ContentSource } from '../../src/content/model.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const RESTAURANT_DIRS: Record<ContentSource, string> = {
  content: path.join(ROOT, 'content', 'restaurants'),
  fixtures: path.join(ROOT, 'fixtures', 'restaurants'),
};
/** Private, git-ignored staging area for drafts that are not yet approved for the public repository. */
export const DRAFTS_DIR = path.join(ROOT, 'drafts');
/** Private, git-ignored place for contributors' original files. */
export const SUBMISSIONS_DIR = path.join(ROOT, 'submissions');
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
