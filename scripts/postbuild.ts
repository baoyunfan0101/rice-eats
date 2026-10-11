// Runs after `vite build`. It verifies that dist/ contains only files the
// public site needs, then adds the GitHub Pages deep-link pages.
//
// Allowed files (everything else fails the build):
//   index.html                              app shell
//   files listed in Vite's build manifest   JS/CSS bundles and their assets
//   PUBLIC_STATIC_FILES                     hand-made files in public/
//   generated/index.json and generated/restaurants/<id>.json for published ids
//   generated/images/<id>/*.webp            renditions referenced by that data
// Added afterwards: 404.html and r/<id>/index.html (copies of index.html).

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ContentIndex, RestaurantDetail } from '../src/content/model.ts';
import { BASE_PATH, GENERATED_DIR } from '../site.config.ts';
import { DRAFTS_DIR, RESTAURANT_DIRS, ROOT } from './content/paths.ts';
import { findSensitiveMetadata, sniffImageFormat } from './content/privacy.ts';

/** Files in public/ that are deployed as-is. Add new static files here deliberately. */
export const PUBLIC_STATIC_FILES = ['favicon.svg'];
const MANIFEST = path.join('.vite', 'manifest.json');
/** Operating-system clutter (e.g. Finder's .DS_Store) is removed rather than deployed. */
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const RENDITION_NAME = /^[a-z0-9-]+-[0-9a-f]{8}-\d+\.webp$/;

export interface PostbuildOptions {
  /** Published restaurants must come from here (content/restaurants or fixtures/restaurants). */
  restaurantsDir: string;
  /** Private drafts whose ids must never appear in the output. */
  draftsDir?: string;
  base?: string;
  /** Allow fixture data (end-to-end test builds only; never deployed). */
  allowFixtures?: boolean;
}

export async function postbuild(distDir: string, options: PostbuildOptions): Promise<string[]> {
  const base = options.base ?? BASE_PATH;
  const problems: string[] = [];
  const rel = (file: string) => path.relative(distDir, file).split(path.sep).join('/');

  for (const required of ['index.html', MANIFEST, `${GENERATED_DIR}/index.json`]) {
    if (!existsSync(path.join(distDir, required))) {
      return [
        `${required} is missing from ${distDir}; run "npm run build" (content build + vite build)`,
      ];
    }
  }

  // Remove OS clutter, then list everything.
  for (const file of await listFiles(distDir)) {
    if (OS_JUNK.has(path.basename(file))) await rm(file);
  }
  const files = (await listFiles(distDir)).map(rel);

  // 1. App bundles from Vite's manifest.
  const allowed = new Set<string>(['index.html', ...PUBLIC_STATIC_FILES]);
  const manifest = JSON.parse(await readFile(path.join(distDir, MANIFEST), 'utf8')) as Record<
    string,
    { file: string; css?: string[]; assets?: string[] }
  >;
  for (const chunk of Object.values(manifest)) {
    for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])])
      allowed.add(file);
  }

  // 2. Content: only published restaurants from the approved dataset.
  const index = JSON.parse(
    await readFile(path.join(distDir, GENERATED_DIR, 'index.json'), 'utf8'),
  ) as ContentIndex;
  if (index.source !== 'content' && !options.allowFixtures) {
    problems.push(`generated data comes from "${index.source}", not content/restaurants`);
  }
  if (index.includesDrafts)
    problems.push(
      'generated data was built with drafts included (dev:drafts); run "npm run build"',
    );
  const approved = await publishedIds(options.restaurantsDir);
  const indexIds = index.restaurants.map((r) => r.id);
  for (const r of index.restaurants) {
    if (r.status !== 'published') problems.push(`restaurant "${r.id}" is not published`);
    if (!approved.has(r.id)) {
      problems.push(
        `restaurant "${r.id}" is not a published restaurant in ${path.relative(ROOT, options.restaurantsDir)}`,
      );
    }
  }
  for (const id of approved) {
    if (!indexIds.includes(id))
      problems.push(`published restaurant "${id}" is missing from the generated data`);
  }

  allowed.add(`${GENERATED_DIR}/index.json`);
  const referencedImages = new Set<string>();
  const collectImages = (data: unknown) => {
    // Image URLs appear in cover/dish assets, srcset lists, and review HTML.
    const prefix = `${base}${GENERATED_DIR}/images/`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of JSON.stringify(data).matchAll(
      new RegExp(`${prefix}[A-Za-z0-9._/-]+`, 'g'),
    )) {
      referencedImages.add(match[0].slice(base.length));
    }
  };
  collectImages(index);
  for (const id of indexIds) {
    const file = `${GENERATED_DIR}/restaurants/${id}.json`;
    allowed.add(file);
    if (!files.includes(file)) {
      problems.push(`${file} is missing`);
      continue;
    }
    const detail = JSON.parse(await readFile(path.join(distDir, file), 'utf8')) as RestaurantDetail;
    if (detail.id !== id || detail.status !== 'published')
      problems.push(`${file} is not the published "${id}"`);
    collectImages(detail);
  }

  // 3. Images: referenced, processed by the pipeline, metadata-free WebP.
  for (const image of referencedImages) {
    const [, , id, name] = image.split('/');
    if (!id || !indexIds.includes(id) || !name || !RENDITION_NAME.test(name)) {
      problems.push(`unexpected image reference ${image}`);
      continue;
    }
    allowed.add(image);
    if (!files.includes(image)) {
      problems.push(`referenced image ${image} is missing`);
      continue;
    }
    const full = path.join(distDir, image);
    if ((await sniffImageFormat(full)) !== 'webp')
      problems.push(`${image} is not a WebP rendition`);
    else if ((await findSensitiveMetadata(full)).length > 0)
      problems.push(`${image} contains embedded metadata`);
  }

  // 4. Nothing else may be deployed.
  for (const file of files) {
    if (file === MANIFEST || allowed.has(file)) continue;
    const fromPublic = existsSync(path.join(ROOT, 'public', file));
    problems.push(
      `unauthorized file in build output: ${file}` +
        (fromPublic
          ? ` (copied from public/${file}; remove it, or add it to PUBLIC_STATIC_FILES in scripts/postbuild.ts if it must be deployed)`
          : ' (not produced by the app build or the content pipeline)'),
    );
  }

  // 5. Unapproved restaurant ids must not appear anywhere in paths.
  const hidden = new Set([
    ...(await allIds(options.restaurantsDir)),
    ...(await allIds(options.draftsDir)),
  ]);
  for (const id of approved) hidden.delete(id);
  for (const file of files) {
    for (const id of hidden) {
      if (file.split('/').some((part) => part === id || part === `${id}.json`)) {
        problems.push(`unpublished restaurant "${id}" appears in ${file}`);
      }
    }
  }

  if (problems.length > 0) return [...new Set(problems)];

  await rm(path.join(distDir, '.vite'), { recursive: true });
  const indexHtml = path.join(distDir, 'index.html');
  await copyFile(indexHtml, path.join(distDir, '404.html'));
  for (const id of indexIds) {
    await mkdir(path.join(distDir, 'r', id), { recursive: true });
    await copyFile(indexHtml, path.join(distDir, 'r', id, 'index.html'));
  }
  return [];
}

async function readInfos(dir: string | undefined): Promise<{ id?: unknown; status?: unknown }[]> {
  if (!dir || !existsSync(dir)) return [];
  const infos = [];
  for (const folder of await readdir(dir)) {
    const file = path.join(dir, folder, 'info.json');
    if (!existsSync(file)) continue;
    try {
      infos.push(JSON.parse(await readFile(file, 'utf8')) as { id?: unknown; status?: unknown });
    } catch {
      // Invalid files fail the content build before this point.
    }
  }
  return infos;
}

async function publishedIds(dir: string): Promise<Set<string>> {
  return new Set(
    (await readInfos(dir))
      .filter((i) => i.status === 'published' && typeof i.id === 'string')
      .map((i) => i.id as string),
  );
}

async function allIds(dir: string | undefined): Promise<string[]> {
  return (await readInfos(dir)).filter((i) => typeof i.id === 'string').map((i) => i.id as string);
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

if (import.meta.main) {
  // --e2e checks the fixture build used only by end-to-end tests (never deployed).
  const e2e = process.argv.includes('--e2e');
  const problems = await postbuild(path.join(ROOT, e2e ? 'dist-e2e' : 'dist'), {
    restaurantsDir: RESTAURANT_DIRS[e2e ? 'fixtures' : 'content'],
    draftsDir: e2e ? undefined : DRAFTS_DIR,
    allowFixtures: e2e,
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error   ${problem}`);
    console.error('\nBuild output check failed; dist/ must not be deployed.');
    process.exit(1);
  }
  console.log('Build output checked against the allowlist; deep-link pages written.');
}
