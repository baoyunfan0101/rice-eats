import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { errors, makeImage, pipeline, tempDir, validInfo, writeRestaurant } from './helpers.ts';

describe('content pipeline', () => {
  it('includes valid published content and writes website data', async () => {
    const root = await tempDir();
    const dir = await writeRestaurant(
      root,
      'noodles',
      validInfo('noodles', { cover: 'images/cover.jpg' }),
      {
        'review.md': '# Title\n\nHello **world**.\n\n![A bowl](images/bowl.png "Caption here")\n',
      },
    );
    await makeImage(path.join(dir, 'images/cover.jpg'), { width: 2000, height: 1500 });
    await makeImage(path.join(dir, 'images/bowl.png'), { format: 'png' });

    const outDir = path.join(await tempDir(), 'out');
    const result = await pipeline(root, { outDir });
    expect(errors(result)).toEqual([]);
    expect(result.index.restaurants.map((r) => r.id)).toEqual(['noodles']);

    const detail = result.details[0]!;
    expect(detail.cover?.src).toMatch(
      /^\/rice-eats\/generated\/images\/noodles\/cover-[0-9a-f]{8}-960\.webp$/,
    );
    expect(detail.cover?.width).toBe(1600);
    expect(detail.reviewHtml).toContain('<h2>Title</h2>');
    expect(detail.reviewHtml).toMatch(
      /<figure><img src="\/rice-eats\/generated\/images\/noodles\/bowl-/,
    );
    expect(detail.reviewHtml).toContain('<figcaption>Caption here</figcaption>');
    expect(detail.reviewHtml).toContain('alt="A bowl"');

    const index = JSON.parse(await readFile(path.join(outDir, 'index.json'), 'utf8'));
    expect(index.restaurants).toHaveLength(1);
    expect(existsSync(path.join(outDir, 'restaurants', 'noodles.json'))).toBe(true);
    // Every URL referenced in the data exists in the output.
    const urls =
      JSON.stringify(result.details).match(/\/rice-eats\/generated\/[^" ,]+\.webp/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(existsSync(path.join(outDir, url.replace('/rice-eats/generated/', '')))).toBe(true);
    }
    // Only processed images are published, never the sources.
    const images = await readdir(path.join(outDir, 'images', 'noodles'));
    expect(images.every((name) => name.endsWith('.webp'))).toBe(true);
  });

  it('excludes drafts unless previewing drafts', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'a', validInfo('a'));
    await writeRestaurant(root, 'b', validInfo('b', { status: 'draft' }));
    const published = await pipeline(root);
    expect(published.index.restaurants.map((r) => r.id)).toEqual(['a']);
    expect(published.index.includesDrafts).toBe(false);
    const preview = await pipeline(root, { includeDrafts: true });
    expect(preview.index.restaurants.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('fails on invalid published content with actionable messages, and writes nothing', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'bad', {
      id: 'Bad Id',
      status: 'published',
      name: '',
      extra: true,
    });
    const outDir = path.join(await tempDir(), 'out');
    const result = await pipeline(root, { outDir });
    expect(result.failed).toBe(true);
    expect(errors(result).join('\n')).toMatch(/id: must be lowercase/);
    expect(errors(result).join('\n')).toMatch(/name: must not be empty/);
    expect(errors(result).join('\n')).toMatch(/Unrecognized key: "extra"/);
    expect(result.diagnostics[0]!.file).toContain(path.join('bad', 'info.json'));
    expect(existsSync(outDir)).toBe(false);
  });

  it('reports invalid JSON', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'broken', '{ "id": ');
    const result = await pipeline(root);
    expect(errors(result)[0]).toMatch(/invalid JSON/);
  });

  it('does not let problems in drafts block a build', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'ok', validInfo('ok'));
    await writeRestaurant(root, 'wip', {
      id: 'wip',
      status: 'draft',
      name: 'WIP',
      cover: 'images/missing.jpg',
    });
    const result = await pipeline(root);
    expect(result.failed).toBe(false);
    const draft = result.diagnostics.find((d) => d.restaurantId === 'wip');
    expect(draft).toMatchObject({ level: 'warning', draftError: true });
    expect(result.index.restaurants.map((r) => r.id)).toEqual(['ok']);
  });

  it('detects duplicate identifiers', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'one', validInfo('same'));
    await writeRestaurant(root, 'two', validInfo('same'));
    const result = await pipeline(root);
    expect(result.failed).toBe(true);
    expect(errors(result)).toHaveLength(2);
    expect(errors(result)[0]).toMatch(/duplicate id "same"/);
  });

  it('detects missing and unsafe asset references', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'a', validInfo('a', { cover: 'images/nope.jpg' }));
    await writeRestaurant(root, 'b', validInfo('b', { cover: '../a/info.json' }));
    await writeRestaurant(root, 'c', validInfo('c'), {
      'review.md': '![x](https://example.com/x.jpg)\n\n![y](images/gone.png)\n',
    });
    await writeRestaurant(root, 'd', validInfo('d', { cover: 'notes.txt' }), { 'notes.txt': 'hi' });
    const messages = errors(await pipeline(root)).join('\n');
    expect(messages).toMatch(/cover: file "images\/nope.jpg" does not exist/);
    expect(messages).toMatch(/cover: must be a relative path inside the restaurant folder/);
    expect(messages).toMatch(/must be a local file in images\/, not a URL/);
    expect(messages).toMatch(/image: file "images\/gone.png" does not exist/);
    expect(messages).toMatch(/unsupported image format ".txt"/);
  });

  it('rejects invalid coordinates and hints at swapped lat/lng', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'range', validInfo('range', { location: { lat: 95, lng: -95.4 } }));
    await writeRestaurant(
      root,
      'swapped',
      validInfo('swapped', { location: { lat: -95.4, lng: 29.72 } }),
    );
    await writeRestaurant(root, 'far', validInfo('far', { location: { lat: 40.7, lng: -74 } }));
    const messages = errors(await pipeline(root)).join('\n');
    expect(messages).toMatch(/location.lat: must be between -90 and 90/);
    expect(messages).toMatch(/lat and lng look swapped/);
    expect(messages).toMatch(/km from Rice University; check the coordinates/);
  });

  it('requires attribution before publishing', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'a', { ...validInfo('a'), contributors: undefined });
    expect(errors(await pipeline(root))[0]).toMatch(/at least one entry in "contributors"/);
  });

  it('sanitizes review Markdown', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'a', validInfo('a'), {
      'review.md': [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '[bad](javascript:alert(1)) [good](https://example.com)',
        '<div onclick="x">raw html</div>',
      ].join('\n\n'),
    });
    const html = (await pipeline(root)).details[0]!.reviewHtml;
    expect(html).not.toMatch(/<script|onerror|onclick|javascript:|<div/i);
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">good</a>',
    );
  });

  it('works with zero restaurants and skips folders without info.json', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'x', validInfo('x'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(root, 'empty-folder'));
    const result = await pipeline(root);
    expect(result.failed).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes('skipped: no info.json'))).toBe(true);

    const empty = await pipeline(path.join(await tempDir(), 'does-not-exist'));
    expect(empty.failed).toBe(false);
    expect(empty.index.restaurants).toEqual([]);
  });

  it('derives a Google Maps link when none is given', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'a', validInfo('a', { address: '1 Main St' }));
    await writeRestaurant(
      root,
      'b',
      validInfo('b', { links: { googleMaps: 'https://maps.google.com/?cid=1' } }),
    );
    const [a, b] = (await pipeline(root)).details;
    expect(a!.mapsUrl).toBe(
      'https://www.google.com/maps/search/?api=1&query=Test%20a%2C%201%20Main%20St',
    );
    expect(b!.mapsUrl).toBe('https://maps.google.com/?cid=1');
  });
});
