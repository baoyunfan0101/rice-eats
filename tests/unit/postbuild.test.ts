import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { postbuild } from '../../scripts/postbuild.ts';
import { makeImage, makePhonePhoto, tempDir, validInfo, writeRestaurant } from './helpers.ts';

const BASE = '/rice-eats/';
const IMG = 'generated/images/a/cover-0123abcd-480.webp';

/** A minimal valid build: one published restaurant "a" with one image. */
async function setup() {
  const content = await tempDir();
  const drafts = await tempDir();
  await writeRestaurant(content, 'a', validInfo('a'));
  await writeRestaurant(content, 'hidden', validInfo('hidden', { status: 'draft' }));
  await writeRestaurant(drafts, 'secret', { id: 'secret', status: 'draft', name: 'Secret' });

  const dist = await tempDir();
  const write = async (file: string, data: string | object) => {
    await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
    await writeFile(path.join(dist, file), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const cover = {
    src: `${BASE}${IMG}`,
    srcset: `${BASE}${IMG} 480w`,
    width: 480,
    height: 320,
    alt: 'a',
  };
  const summary = {
    id: 'a',
    status: 'published',
    name: 'A',
    altNames: [],
    cuisines: [],
    tags: [],
    cover,
  };
  await write('index.html', '<!doctype html>');
  await write('favicon.svg', '<svg/>');
  await write('assets/index-abc.js', '');
  await write('assets/index-abc.css', '');
  await write('assets/layers-xyz.png', '');
  await write('.vite/manifest.json', {
    'index.html': {
      file: 'assets/index-abc.js',
      css: ['assets/index-abc.css'],
      assets: ['assets/layers-xyz.png'],
    },
  });
  await write('generated/index.json', {
    source: 'content',
    includesDrafts: false,
    restaurants: [summary],
  });
  await write('generated/restaurants/a.json', {
    ...summary,
    dishes: [],
    reviewHtml: '',
    contributors: [],
  });
  await makeImage(path.join(dist, IMG.replace('.webp', '.tmp.webp')), { format: 'webp' });
  const { rename } = await import('node:fs/promises');
  await rename(path.join(dist, IMG.replace('.webp', '.tmp.webp')), path.join(dist, IMG));
  const run = () => postbuild(dist, { restaurantsDir: content, draftsDir: drafts, base: BASE });
  return { dist, write, run };
}

describe('postbuild allowlist', () => {
  it('accepts a valid build and writes deep-link pages', async () => {
    const { dist, write, run } = await setup();
    await write('.DS_Store', 'junk'); // OS clutter is removed, not deployed
    expect(await run()).toEqual([]);
    expect(existsSync(path.join(dist, '404.html'))).toBe(true);
    expect(existsSync(path.join(dist, 'r/a/index.html'))).toBe(true);
    expect(existsSync(path.join(dist, '.vite'))).toBe(false);
    expect(existsSync(path.join(dist, '.DS_Store'))).toBe(false);
  });

  it('works with zero restaurants', async () => {
    const content = await tempDir();
    const dist = await tempDir();
    await mkdir(path.join(dist, '.vite'), { recursive: true });
    await mkdir(path.join(dist, 'generated'), { recursive: true });
    await writeFile(path.join(dist, 'index.html'), '');
    await writeFile(path.join(dist, '.vite/manifest.json'), '{}');
    await writeFile(
      path.join(dist, 'generated/index.json'),
      JSON.stringify({ source: 'content', includesDrafts: false, restaurants: [] }),
    );
    expect(await postbuild(dist, { restaurantsDir: content, base: BASE })).toEqual([]);
  });

  it.each([
    ['an unauthorized JPEG copied from public/', 'photo.jpg', 'jpeg'],
    ['an arbitrary text file', 'notes.txt', 'text'],
    ['a source document', 'generated/review.docx', 'text'],
    ['an unreferenced image', 'generated/images/a/extra-0123abcd-480.webp', 'webp'],
    ['arbitrary extra JSON', 'generated/extra.json', 'text'],
  ])('rejects %s', async (_label, file, kind) => {
    const { dist, write, run } = await setup();
    if (kind === 'text') await write(file, 'x');
    else await makeImage(path.join(dist, file), { format: kind as 'jpeg' | 'webp' });
    const problems = await run();
    expect(problems.join('\n')).toContain(`unauthorized file in build output: ${file}`);
    expect(existsSync(path.join(dist, '404.html'))).toBe(false);
  });

  it('rejects unpublished restaurant data', async () => {
    const { write, run } = await setup();
    await write('generated/restaurants/secret.json', { id: 'secret', status: 'draft' });
    await write('generated/restaurants/hidden.json', { id: 'hidden', status: 'draft' });
    const problems = (await run()).join('\n');
    expect(problems).toMatch(
      /unauthorized file in build output: generated\/restaurants\/secret.json/,
    );
    expect(problems).toMatch(/unpublished restaurant "secret" appears/);
    expect(problems).toMatch(/unpublished restaurant "hidden" appears/);
  });

  it('rejects fixture data, drafts in the index, and restaurants outside the approved dataset', async () => {
    const { write, run } = await setup();
    await write('generated/index.json', {
      source: 'fixtures',
      includesDrafts: true,
      restaurants: [{ id: 'fixture-x', status: 'draft' }],
    });
    const problems = (await run()).join('\n');
    expect(problems).toMatch(/comes from "fixtures"/);
    expect(problems).toMatch(/built with drafts included/);
    expect(problems).toMatch(/"fixture-x" is not published/);
    expect(problems).toMatch(/"fixture-x" is not a published restaurant/);
    expect(problems).toMatch(/published restaurant "a" is missing/);
  });

  it('rejects images that are not clean pipeline renditions', async () => {
    const { dist, run } = await setup();
    await makePhonePhoto(path.join(dist, IMG)); // a JPEG with GPS under a .webp name
    expect((await run()).join('\n')).toMatch(/cover-0123abcd-480.webp is not a WebP rendition/);
  });
});
