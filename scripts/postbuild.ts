// Runs after `vite build`:
// 1. Makes deep links work on GitHub Pages: every published restaurant gets
//    dist/r/<id>/index.html (served with HTTP 200), and dist/404.html loads the
//    app for any other path so it can show its own "not found" page.
// 2. Fails the build if drafts, fixtures, or source files leaked into dist/.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContentIndex } from '../src/content/model.ts';
import { RESTAURANT_DIRS, ROOT } from './content/paths.ts';
import { GENERATED_DIR } from '../site.config.ts';

export async function postbuild(
  distDir: string,
  restaurantsDir: string,
  { allowFixtures = false } = {},
): Promise<string[]> {
  const problems: string[] = [];
  const indexHtml = path.join(distDir, 'index.html');
  const indexJson = path.join(distDir, GENERATED_DIR, 'index.json');
  if (!existsSync(indexHtml)) return [`${indexHtml} is missing; run vite build first`];
  if (!existsSync(indexJson)) return [`${indexJson} is missing; run npm run content:build first`];

  const index = JSON.parse(await readFile(indexJson, 'utf8')) as ContentIndex;
  if (index.source !== 'content' && !allowFixtures)
    problems.push(`dist contains "${index.source}" data instead of real content`);
  if (index.includesDrafts) problems.push('dist was built with drafts included');
  for (const r of index.restaurants) {
    if (r.status !== 'published') problems.push(`dist includes unpublished restaurant "${r.id}"`);
  }

  // Draft ids from the source folder must not appear anywhere in the output.
  const draftIds = await listDraftIds(restaurantsDir);
  const files = await listFiles(distDir);
  for (const file of files) {
    const rel = path.relative(distDir, file);
    if (/\.(md|heic|heif|docx?|rtf|pdf)$/i.test(rel))
      problems.push(`source file leaked into dist: ${rel}`);
    if (rel.startsWith(`${GENERATED_DIR}${path.sep}images`) && !rel.endsWith('.webp')) {
      problems.push(`unprocessed image in dist: ${rel}`);
    }
    for (const id of draftIds) {
      if (rel.split(path.sep).includes(id) || rel.includes(`${id}.json`)) {
        problems.push(`draft "${id}" leaked into dist: ${rel}`);
      }
    }
  }
  if (problems.length > 0) return problems;

  await copyFile(indexHtml, path.join(distDir, '404.html'));
  for (const r of index.restaurants) {
    const dir = path.join(distDir, 'r', r.id);
    await mkdir(dir, { recursive: true });
    await copyFile(indexHtml, path.join(dir, 'index.html'));
  }
  return [];
}

async function listDraftIds(restaurantsDir: string): Promise<string[]> {
  if (!existsSync(restaurantsDir)) return [];
  const ids: string[] = [];
  for (const folder of await readdir(restaurantsDir)) {
    const info = path.join(restaurantsDir, folder, 'info.json');
    if (!existsSync(info)) continue;
    try {
      const data = JSON.parse(await readFile(info, 'utf8')) as { id?: unknown; status?: unknown };
      if (data.status !== 'published' && typeof data.id === 'string') ids.push(data.id);
    } catch {
      // Invalid files are reported by the content pipeline.
    }
  }
  return ids;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

if (import.meta.main) {
  // --e2e checks a fixture build used only by the end-to-end tests (never deployed).
  const e2e = process.argv.includes('--e2e');
  const problems = await postbuild(
    path.join(ROOT, e2e ? 'dist-e2e' : 'dist'),
    RESTAURANT_DIRS[e2e ? 'fixtures' : 'content'],
    { allowFixtures: e2e },
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error   ${problem}`);
    console.error('\nBuild output check failed.');
    process.exit(1);
  }
  console.log('Build output checked; deep-link pages written.');
}
