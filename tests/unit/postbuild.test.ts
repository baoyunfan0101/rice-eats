import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { postbuild } from '../../scripts/postbuild.ts';
import { tempDir, validInfo, writeRestaurant } from './helpers.ts';

async function makeDist(index: object, extraFiles: string[] = []) {
  const dist = await tempDir();
  await mkdir(path.join(dist, 'generated', 'images', 'a'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html>');
  await writeFile(path.join(dist, 'generated', 'index.json'), JSON.stringify(index));
  for (const file of extraFiles) {
    await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
    await writeFile(path.join(dist, file), 'x');
  }
  return dist;
}

const published = (id: string) => ({ id, status: 'published' });

describe('postbuild', () => {
  it('writes deep-link pages and 404.html for published restaurants', async () => {
    const dist = await makeDist({
      source: 'content',
      includesDrafts: false,
      restaurants: [published('a')],
    });
    expect(await postbuild(dist, await tempDir())).toEqual([]);
    expect(existsSync(path.join(dist, '404.html'))).toBe(true);
    expect(existsSync(path.join(dist, 'r', 'a', 'index.html'))).toBe(true);
  });

  it('works with zero restaurants', async () => {
    const dist = await makeDist({ source: 'content', includesDrafts: false, restaurants: [] });
    expect(await postbuild(dist, await tempDir())).toEqual([]);
  });

  it('rejects fixtures, drafts, and leaked source files', async () => {
    const content = await tempDir();
    await writeRestaurant(content, 'secret', validInfo('secret-draft', { status: 'draft' }));
    const dist = await makeDist(
      { source: 'fixtures', includesDrafts: true, restaurants: [{ id: 'd', status: 'draft' }] },
      ['generated/images/a/raw.jpg', 'review.md', 'generated/restaurants/secret-draft.json'],
    );
    const problems = (await postbuild(dist, content)).join('\n');
    expect(problems).toMatch(/"fixtures" data/);
    expect(problems).toMatch(/built with drafts included/);
    expect(problems).toMatch(/unpublished restaurant "d"/);
    expect(problems).toMatch(/unprocessed image in dist/);
    expect(problems).toMatch(/source file leaked into dist: review.md/);
    expect(problems).toMatch(/draft "secret-draft" leaked/);
    expect(existsSync(path.join(dist, '404.html'))).toBe(false);
  });
});
