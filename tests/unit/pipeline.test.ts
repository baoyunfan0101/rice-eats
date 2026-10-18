import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeImage,
  makePhonePhoto,
  pipeline,
  tempDir,
  validInfo,
  writeRestaurant,
} from './helpers.ts';

/** A public contributor list with these people. */
const contributors = async (people: { id: string; name: string }[]) => {
  const file = path.join(await tempDir(), 'contributors.json');
  await writeFile(file, JSON.stringify(people));
  return file;
};

// "file: message" lines, so tests can check which file a problem is about.
const errors = (result: { diagnostics: { level: string; file: string; message: string }[] }) =>
  result.diagnostics.filter((d) => d.level === 'error').map((d) => `${d.file}: ${d.message}`);

describe('content pipeline', () => {
  it('includes valid published content and writes website data', async () => {
    const root = await tempDir();
    const dir = await writeRestaurant(root, 'noodles', validInfo('noodles'), {
      'reviews/u-001.json': JSON.stringify({
        date: '2026-10-01',
        rating: 4,
        images: ['images/02-bowl.png'],
      }),
      'reviews/u-001.md': '# Title\n\nHello **world**.\n',
    });
    await makeImage(path.join(dir, 'images/01-front.jpg'), { width: 2000, height: 1500 });
    await makeImage(path.join(dir, 'images/02-bowl.png'), { format: 'png' });

    const outDir = path.join(await tempDir(), 'out');
    const result = await pipeline(root, { outDir });
    expect(errors(result)).toEqual([]);
    expect(result.index.restaurants.map((r) => r.id)).toEqual(['noodles']);

    const detail = result.details[0]!;
    // The first image is the cover; its alt text is the restaurant name.
    expect(detail.cover?.src).toMatch(
      /^\/rice-eats\/generated\/images\/noodles\/01-front-[0-9a-f]{8}-960\.webp$/,
    );
    expect(detail.cover).toMatchObject({ width: 1600, alt: 'Test noodles' });
    expect(detail.images.map((i) => i.alt)).toEqual(['Test noodles', 'Test noodles (2)']);
    // A review's headings start at <h3> (under the page title and "点评").
    expect(detail.reviews).toMatchObject([
      {
        id: 'u-001',
        contributor: { id: 'u-001', name: 'Tester' },
        date: '2026-10-01',
        rating: 4,
        imageIndexes: [1],
        dishes: [],
      },
    ]);
    expect(detail.reviews[0]!.html).toContain('<h3>Title</h3>');
    expect(detail.contributors).toEqual([{ id: 'u-001', name: 'Tester' }]);
    expect(detail).toMatchObject({ rating: 4, ratingAverage: 4, reviewCount: 1 });

    const index = JSON.parse(await readFile(path.join(outDir, 'index.json'), 'utf8'));
    expect(index.restaurants).toHaveLength(1);
    expect(index.restaurants[0]).toMatchObject({ rating: 4, reviewCount: 1 });
    expect(existsSync(path.join(outDir, 'restaurants', 'noodles.json'))).toBe(true);
    const urls =
      JSON.stringify(result.details).match(/\/rice-eats\/generated\/[^" ,]+\.webp/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(existsSync(path.join(outDir, url.replace('/rice-eats/generated/', '')))).toBe(true);
    }
    const images = await readdir(path.join(outDir, 'images', 'noodles'));
    expect(images.every((name) => name.endsWith('.webp'))).toBe(true);
  });

  it('accepts a minimal restaurant: only id, status, name, and a review', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'bare', { id: 'bare', status: 'published', name: 'Bare' });
    const result = await pipeline(root);
    expect(errors(result)).toEqual([]);
    expect(result.details[0]).toMatchObject({
      cuisines: [],
      tags: [],
      images: [],
      dishes: [],
      reviews: [{ id: 'u-001', html: '', imageIndexes: [], dishes: [] }],
      reviewCount: 1,
      links: {},
    });
    expect(result.details[0]!).toMatchObject({ rating: 4, ratingAverage: 4 });
    expect(result.details[0]!.cover).toBeUndefined();
  });

  it('shows photo-only reviews: no text or dishes needed', async () => {
    const root = await tempDir();
    const dir = await writeRestaurant(
      root,
      'photos',
      { id: 'photos', status: 'published', name: 'Photos' },
      {
        'reviews/u-001.json': JSON.stringify({
          date: '2026-10-01',
          rating: 3,
          images: ['images/01-a.jpg', 'images/02-b.jpg', 'images/03-c.jpg'],
        }),
      },
    );
    for (const name of ['01-a.jpg', '02-b.jpg', '03-c.jpg'])
      await makeImage(path.join(dir, 'images', name));
    const detail = (await pipeline(root)).details[0]!;
    expect(detail.images).toHaveLength(3);
    expect(detail.cover).toEqual(detail.images[0]);
    expect(detail.reviews[0]).toMatchObject({ html: '', imageIndexes: [0, 1, 2] });
  });

  it('orders images by their number, so a new image never changes the cover', async () => {
    const root = await tempDir();
    const dir = await writeRestaurant(root, 'r', validInfo('r'));
    for (const name of ['10-z.jpg', '02-b.jpg', '01-a.jpg', '09-y.jpg'])
      await makeImage(path.join(dir, 'images', name));
    const order = async () =>
      (await pipeline(root)).details[0]!.images.map((i) =>
        i.src.split('/').pop()!.split('-').slice(0, 2).join('-'),
      );
    expect(await order()).toEqual(['01-a', '02-b', '09-y', '10-z']);
    await makeImage(path.join(dir, 'images', '11-new.jpg'));
    expect((await order())[0]).toBe('01-a');
  });

  it('rejects non-standardized images in the database', async () => {
    const root = await tempDir();
    const dir = await writeRestaurant(root, 'r', validInfo('r'));
    await makeImage(path.join(dir, 'images/IMG_1234.JPG'));
    await makeImage(path.join(dir, 'images/02-big.jpg'), { width: 3000, height: 1000 });
    await makeImage(path.join(dir, 'images/03-fake.jpg'), { format: 'png' });
    await makeImage(path.join(dir, 'images/04-photo.webp'), { format: 'webp' });
    await writeFile(path.join(dir, 'notes.txt'), 'raw submission text');
    const messages = errors(await pipeline(root)).join('\n');
    expect(messages).toMatch(
      /IMG_1234.JPG: not a standardized image: name must look like "03-dish-name.jpg"/,
    );
    expect(messages).toMatch(/02-big.jpg: not a standardized image: larger than 2400px/);
    expect(messages).toMatch(/03-fake.jpg: not a standardized image: content is png, not jpeg/);
    expect(messages).toMatch(/04-photo.webp: not a standardized image: name must look like/);
    expect(messages).toMatch(/unexpected file "notes.txt"/);
  });

  it('excludes drafts unless previewing drafts', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'a', validInfo('a'));
    await writeRestaurant(root, 'b', validInfo('b', { status: 'draft' }));
    expect((await pipeline(root)).index.restaurants.map((r) => r.id)).toEqual(['a']);
    const preview = await pipeline(root, { includeDrafts: true });
    expect(preview.index.restaurants.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('requires a name and keeps other names in altNames', async () => {
    const root = await tempDir();
    await writeRestaurant(
      root,
      'multi',
      validInfo('multi', { name: '双语面馆', altNames: ['Twin Noodles'] }),
    );
    const ok = await pipeline(root);
    expect(errors(ok)).toEqual([]);
    expect(ok.details[0]).toMatchObject({ name: '双语面馆', altNames: ['Twin Noodles'] });

    const bad = await tempDir();
    const noName: Record<string, unknown> = validInfo('nameless');
    delete noName.name;
    await writeRestaurant(bad, 'nameless', noName);
    expect(errors(await pipeline(bad)).join('\n')).toMatch(/name: /);
  });

  it('fails on invalid published content with actionable messages, and writes nothing', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'bad', {
      id: 'Bad Id',
      status: 'published',
      name: '',
      summary: 'removed field',
      cuisines: ['越南菜'],
      tags: ['Not A Tag'],
    });
    const outDir = path.join(await tempDir(), 'out');
    const result = await pipeline(root, { outDir });
    const messages = errors(result).join('\n');
    expect(result.failed).toBe(true);
    expect(messages).toMatch(/id: must be lowercase/);
    expect(messages).toMatch(/name: must not be empty/);
    expect(messages).toMatch(/Unrecognized key: "summary"/);
    expect(messages).toMatch(/cuisines.0: unknown cuisine; use one of .*vietnamese/);
    expect(messages).toMatch(/tags.0: must be a lowercase slug/);
    expect(existsSync(outDir)).toBe(false);
  });

  it.each(['summary', 'neighborhood', 'cover', 'coverAlt', 'contributors'])(
    'rejects the removed field "%s"',
    async (field) => {
      const root = await tempDir();
      await writeRestaurant(root, 'r', validInfo('r', { [field]: 'x' }));
      expect(errors(await pipeline(root)).join('\n')).toContain(`Unrecognized key: "${field}"`);
    },
  );

  it('reports invalid JSON', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'broken', '{ "id": ');
    expect(errors(await pipeline(root))[0]).toMatch(/invalid JSON/);
  });

  it('does not let problems in drafts block a build', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'ok', validInfo('ok'));
    await writeRestaurant(root, 'wip', {
      id: 'wip',
      status: 'draft',
      name: 'WIP',
      dishes: [{ name: 'x', images: ['images/01-missing.jpg'] }],
    });
    const result = await pipeline(root);
    expect(result.failed).toBe(false);
    expect(result.diagnostics.find((d) => d.restaurantId === 'wip')).toMatchObject({
      level: 'warning',
      draftError: true,
    });
    expect(result.index.restaurants.map((r) => r.id)).toEqual(['ok']);
  });

  it('detects duplicate ids and folder names that differ from the id', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'one', validInfo('same'));
    await writeRestaurant(root, 'same', validInfo('same'));
    const messages = errors(await pipeline(root)).join('\n');
    expect(messages).toMatch(/duplicate id "same"/);
    expect(messages).toMatch(/folder name "one" must equal the id "same"/);
  });

  it('allows restaurants with the same name under different ids', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'r-aaaaaa', validInfo('r-aaaaaa', { name: '街角塔可' }));
    await writeRestaurant(root, 'r-bbbbbb', validInfo('r-bbbbbb', { name: '街角塔可' }));
    const result = await pipeline(root);
    expect(errors(result)).toEqual([]);
    expect(result.index.restaurants.map((r) => r.id)).toEqual(['r-aaaaaa', 'r-bbbbbb']);
  });

  it('detects missing, unsafe, shared, and text-placed image references', async () => {
    const root = await tempDir();
    const review = (data: object) => JSON.stringify({ date: '2026-10-01', rating: 3, ...data });
    await writeRestaurant(root, 'a', validInfo('a', { dishes: [{ id: 'd1', name: 'x' }] }), {
      'reviews/u-001.json': review({ dishes: [{ dish: 'd1', images: ['images/01-nope.jpg'] }] }),
    });
    await writeRestaurant(root, 'b', validInfo('b'), {
      'reviews/u-001.json': review({ images: ['../a/info.json'] }),
    });
    const c = await writeRestaurant(root, 'c', validInfo('c'), {
      'reviews/u-001.json': review({ images: ['images/01-a.jpg'] }),
      'reviews/u-001.md': '![x](images/01-a.jpg)\n',
      'reviews/u-002.json': review({ images: ['images/01-a.jpg'] }),
    });
    await makeImage(path.join(c, 'images/01-a.jpg'));
    const messages = errors(
      await pipeline(root, {
        contributorsFile: await contributors([
          { id: 'u-001', name: 'A' },
          { id: 'u-002', name: 'B' },
        ]),
      }),
    ).join('\n');
    expect(messages).toMatch(/a\/reviews\/u-001.json: "images\/01-nope.jpg" is not in images\//);
    expect(messages).toMatch(/images.0: must be a file in the restaurant's images\/ folder/);
    expect(messages).toMatch(/c\/reviews\/u-001.md: the review text may not place images/);
    expect(messages).toMatch(
      /"images\/01-a.jpg" is also used by the review of u-00\d; a photo belongs to one review/,
    );
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

  it('requires a whole-number rating 1-5 in every review', async () => {
    const root = await tempDir();
    const review = (data: object) => ({
      'reviews/u-001.json': JSON.stringify({ date: '2026-10-01', rating: 3, ...data }),
    });
    for (const rating of [1, 2, 3, 4, 5])
      await writeRestaurant(root, `r${rating}`, validInfo(`r${rating}`), review({ rating }));
    const ok = await pipeline(root);
    expect(errors(ok)).toEqual([]);
    expect(ok.details.map((d) => d.rating).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const [i, rating] of [undefined, 0, 6, 3.5, '5', '夯'].entries()) {
      const bad = await tempDir();
      await writeRestaurant(bad, `x${i}`, validInfo(`x${i}`), review({ rating }));
      expect(errors(await pipeline(bad)).join('\n'), String(rating)).toMatch(
        /u-001.json: rating: /,
      );
    }
  });

  it('averages the reviews: the level, one decimal, and how many reviewed', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'r', validInfo('r'), {
      'reviews/u-001.json': JSON.stringify({ date: '2026-10-01', rating: 5 }),
      'reviews/u-002.json': JSON.stringify({ date: '2026-10-03', rating: 4 }),
      'reviews/u-003.json': JSON.stringify({ date: '2026-10-02', rating: 4 }),
      'reviews/u-004.json': JSON.stringify({ date: '2026-10-02', rating: 4 }),
    });
    const people = [1, 2, 3, 4].map((n) => ({ id: `u-00${n}`, name: `P${n}` }));
    const detail = (await pipeline(root, { contributorsFile: await contributors(people) }))
      .details[0]!;
    expect(detail).toMatchObject({ rating: 4, ratingAverage: 4.3, reviewCount: 4 });
    // Newest first; the same day by contributor id.
    expect(detail.reviews.map((r) => r.id)).toEqual(['u-002', 'u-003', 'u-004', 'u-001']);
  });

  it('counts dish verdicts 1 and -1 (none is no opinion) and rejects other values', async () => {
    const root = await tempDir();
    const dishes = [
      { id: 'd1', name: 'Beef Noodles' },
      { id: 'd2', name: 'Dumplings' },
      { id: 'd3', name: 'Iced Tea' },
    ];
    await writeRestaurant(root, 'r', validInfo('r', { dishes }), {
      'reviews/u-001.json': JSON.stringify({
        date: '2026-10-01',
        rating: 3,
        dishes: [
          { dish: 'd1', verdict: 1, comment: 'Good' },
          { dish: 'd2', verdict: -1 },
          { dish: 'd3' },
        ],
      }),
      'reviews/u-002.json': JSON.stringify({
        date: '2026-10-02',
        rating: 3,
        dishes: [{ dish: 'd1', verdict: 1 }],
      }),
    });
    const ok = await pipeline(root, {
      contributorsFile: await contributors([
        { id: 'u-001', name: 'A' },
        { id: 'u-002', name: 'B' },
      ]),
    });
    expect(errors(ok)).toEqual([]);
    const d = ok.details[0]!.dishes;
    expect(d.map((x) => [x.id, x.recommend, x.avoid])).toEqual([
      ['d1', 2, 0],
      ['d2', 0, 1],
      ['d3', 0, 0],
    ]);
    // Every review's word on the dish, newest first.
    expect(d[0]!.reviews.map((r) => [r.reviewId, r.verdict, r.comment])).toEqual([
      ['u-002', 1, undefined],
      ['u-001', 1, 'Good'],
    ]);
    for (const [i, verdict] of [0, 2, '推荐', true, null].entries()) {
      const bad = await tempDir();
      await writeRestaurant(
        bad,
        `x${i}`,
        validInfo(`x${i}`, { dishes: [{ id: 'd1', name: 'd' }] }),
        {
          'reviews/u-001.json': JSON.stringify({
            date: '2026-10-01',
            rating: 3,
            dishes: [{ dish: 'd1', verdict }],
          }),
        },
      );
      expect(errors(await pipeline(bad)).join('\n'), String(verdict)).toMatch(
        /dishes.0.verdict: must be 1 \(recommended\) or -1/,
      );
    }
    // A review may only rate the restaurant's dishes.
    const unknown = await tempDir();
    await writeRestaurant(unknown, 'u', validInfo('u'), {
      'reviews/u-001.json': JSON.stringify({
        date: '2026-10-01',
        rating: 3,
        dishes: [{ dish: 'd9' }],
      }),
    });
    expect(errors(await pipeline(unknown)).join('\n')).toMatch(
      /dishes.0.dish: "d9" is not one of the dishes/,
    );
  });

  it('records dish photos and review photos as indexes', async () => {
    const root = await tempDir();
    const dir = await writeRestaurant(
      root,
      'r',
      validInfo('r', {
        dishes: [
          { id: 'd1', name: 'Ribs' },
          { id: 'd2', name: 'Tea' },
        ],
      }),
      {
        'reviews/u-001.json': JSON.stringify({
          date: '2026-10-01',
          rating: 3,
          images: ['images/01-front.jpg'],
          dishes: [
            { dish: 'd1', verdict: 1, images: ['images/03-ribs.jpg', 'images/02-room.jpg'] },
            { dish: 'd2' },
          ],
        }),
      },
    );
    for (const name of ['01-front.jpg', '02-room.jpg', '03-ribs.jpg'])
      await makeImage(path.join(dir, 'images', name));
    const detail = (await pipeline(root)).details[0]!;
    expect(detail.dishes.map((d) => d.imageIndexes)).toEqual([[2, 1], []]);
    expect(detail.images.map((i) => i.alt)).toEqual(['Test r', 'Ribs（2/2）', 'Ribs（1/2）']);
    expect(detail.reviews[0]!.imageIndexes).toEqual([0]);
    expect(detail.reviews[0]!.dishes).toEqual([
      { id: 'd1', name: 'Ribs', verdict: 1 },
      { id: 'd2', name: 'Tea' },
    ]);
  });

  it('checks tags against the registry: public restaurants only use public tags', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'a', validInfo('a', { tags: ['date', 'pet-friendly'] }));
    expect(errors(await pipeline(root)).join('\n')).toMatch(
      /tags: "pet-friendly" is not in the tag registry/,
    );
    const drafts = await tempDir();
    await writeRestaurant(drafts, 'b', validInfo('b', { status: 'draft', tags: ['pet-friendly'] }));
    const privateTagsFile = path.join(await tempDir(), 'tags.json');
    await writeFile(
      privateTagsFile,
      JSON.stringify({ proposed: [{ id: 'pet-friendly', label: '可带宠物' }], aliases: {} }),
    );
    const withProposal = await pipeline(root, {
      draftsDir: drafts,
      privateTagsFile,
      includeDrafts: true,
    });
    // A draft may use a proposed tag; the public restaurant still may not.
    expect(withProposal.diagnostics.filter((d) => d.restaurantId === 'b')).toEqual([]);
    expect(errors(withProposal).join('\n')).toMatch(
      /tags: "pet-friendly" is only a proposed tag \(private\/tags.json\); promote the restaurant/,
    );
  });

  it('stores language-independent keys, and tags with their registry labels', async () => {
    const root = await tempDir();
    await writeRestaurant(
      root,
      'a',
      validInfo('a', { cuisines: ['sichuan'], tags: ['date'], dishes: [{ id: 'd1', name: 'd' }] }),
      {
        'reviews/u-001.json': JSON.stringify({
          date: '2026-10-01',
          rating: 2,
          dishes: [{ dish: 'd1', verdict: -1 }],
        }),
      },
    );
    const json = JSON.stringify((await pipeline(root)).details);
    expect(json).toContain('"rating":2');
    expect(json).toContain('"cuisines":["sichuan"]');
    expect(json).toContain('"tags":[{"id":"date","label":"适合约会"}]');
    expect(json).toContain('"verdict":-1');
    expect(json).not.toMatch(/NPC|川菜|避雷/);
  });

  it('needs a review to publish, by a known contributor, in reviews/<contributor id>.json', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'a', validInfo('a'), { 'images/.keep': '' });
    const { rm } = await import('node:fs/promises');
    await rm(path.join(root, 'a', 'reviews'), { recursive: true });
    await writeRestaurant(root, 'b', validInfo('b'), {
      'reviews/u-999.json': JSON.stringify({ date: '2026-10-01', rating: 3 }),
    });
    await writeRestaurant(root, 'c', validInfo('c'), {
      'reviews/u-001.json': JSON.stringify({ date: 'yesterday' }),
      'reviews/notes.txt': 'x',
      'reviews/u-002.md': 'text without its review',
    });
    const messages = errors(await pipeline(root)).join('\n');
    expect(messages).toMatch(
      /a\/info.json: published restaurants need at least one review in reviews\//,
    );
    expect(messages).toMatch(/b\/reviews\/u-999.json: "u-999" is not a known contributor/);
    expect(messages).toMatch(/c\/reviews\/u-001.json: date: must be a date like "2026-10-14"/);
    expect(messages).toMatch(/c\/reviews\/notes.txt: unexpected file/);
    expect(messages).toMatch(/c\/reviews\/u-002.md: a review text needs its u-002.json/);
  });

  it('keeps contact details out of the public contributor list', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'a', validInfo('a'));
    const file = path.join(await tempDir(), 'contributors.json');
    await writeFile(
      file,
      JSON.stringify([{ id: 'u-001', name: 'Tester', email: 'tester@example.com' }]),
    );
    expect(errors(await pipeline(root, { contributorsFile: file })).join('\n')).toMatch(
      /Unrecognized key: "email"/,
    );
    await writeFile(file, JSON.stringify([{ id: 'u-001', name: 'tester@example.com' }]));
    expect(errors(await pipeline(root, { contributorsFile: file })).join('\n')).toMatch(
      /display names are public/,
    );
  });

  it('sanitizes review Markdown', async () => {
    const root = await tempDir();
    await writeRestaurant(root, 'a', validInfo('a'), {
      'reviews/u-001.json': JSON.stringify({ date: '2026-10-01', rating: 3 }),
      'reviews/u-001.md': [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '[bad](javascript:alert(1)) [good](https://example.com)',
        '<div onclick="x">raw html</div>',
      ].join('\n\n'),
    });
    const html = (await pipeline(root)).details[0]!.reviews[0]!.html;
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

  it('passes explicit map links through and leaves derivation to the site', async () => {
    const root = await tempDir();
    await writeRestaurant(
      root,
      'a',
      validInfo('a', { links: { appleMaps: 'https://maps.apple.com/?q=A' } }),
    );
    expect((await pipeline(root)).details[0]!.links).toEqual({
      appleMaps: 'https://maps.apple.com/?q=A',
    });
  });

  it('blocks public photos with embedded metadata, even in unpublished restaurants', async () => {
    const root = await tempDir();
    const dir = await writeRestaurant(root, 'a', validInfo('a', { status: 'draft' }));
    await makePhonePhoto(path.join(dir, 'images/01-gps.jpg'));
    const result = await pipeline(root);
    expect(result.failed).toBe(true);
    expect(errors(result).join('\n')).toMatch(/01-gps.jpg/);
  });

  it('reads private drafts and pending contributors for checks and previews only', async () => {
    const root = await tempDir();
    const drafts = await tempDir();
    const privateFile = path.join(await tempDir(), 'private.json');
    await writeFile(
      privateFile,
      JSON.stringify({ 'u-002': { name: 'New Person', email: 'new@example.com' } }),
    );
    await writeRestaurant(root, 'pub', validInfo('pub'));
    await writeRestaurant(
      drafts,
      'wip',
      { id: 'wip', status: 'draft', name: 'WIP' },
      { 'reviews/u-002.json': JSON.stringify({ date: '2026-10-01', rating: 3 }) },
    );
    await writeRestaurant(drafts, 'early', validInfo('early'));

    expect((await pipeline(root)).index.restaurants.map((r) => r.id)).toEqual(['pub']);
    const preview = await pipeline(root, {
      draftsDir: drafts,
      privateContributorsFile: privateFile,
      includeDrafts: true,
    });
    expect(preview.failed).toBe(false);
    expect(preview.index.restaurants.map((r) => r.id).sort()).toEqual(['pub', 'wip']);
    expect(preview.details.find((d) => d.id === 'wip')!.contributors).toEqual([
      { id: 'u-002', name: 'New Person' },
    ]);
    expect(JSON.stringify(preview.details)).not.toContain('new@example.com');
    const early = preview.diagnostics.find((d) => d.restaurantId === 'early')!;
    expect(early).toMatchObject({ level: 'warning', draftError: true });

    // A public restaurant may not reference a contributor who is still private.
    await writeRestaurant(root, 'leak', validInfo('leak'), {
      'reviews/u-002.json': JSON.stringify({ date: '2026-10-01', rating: 3 }),
    });
    const leak = await pipeline(root, {
      draftsDir: drafts,
      privateContributorsFile: privateFile,
      includeDrafts: true,
    });
    expect(errors(leak).join('\n')).toMatch(/"u-002" is not in the public contributor list/);
  });

  it('treats a private draft with a public id as an edit, not a duplicate', async () => {
    const root = await tempDir();
    const drafts = await tempDir();
    await writeRestaurant(root, 'same', validInfo('same', { name: 'Public version' }));
    await writeRestaurant(
      drafts,
      'same',
      validInfo('same', { status: 'draft', name: 'Edited version' }),
    );
    const build = await pipeline(root, { draftsDir: drafts });
    expect(errors(build)).toEqual([]);
    expect(build.details.map((d) => d.name)).toEqual(['Public version']);
    const preview = await pipeline(root, { draftsDir: drafts, includeDrafts: true });
    expect(preview.details.map((d) => d.name)).toEqual(['Edited version']);
  });
});
