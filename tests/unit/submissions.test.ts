import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  downloadPhotos,
  formatImport,
  importSubmissions,
  markSubmission,
  parseCsv,
  readLog,
  readSubmissions,
  redactUrl,
  resolveIdentity,
  submissionsFromCsv,
  type Submission,
} from '../../scripts/content/submissions.ts';
import { tempDir, validInfo, writeRestaurant } from './helpers.ts';

// Synthetic Tally CSV export: the columns Tally writes (Submission ID,
// Submitted at, question titles, hidden fields). All data is fictional.
const HEADER =
  'Submission ID,Respondent ID,Submitted at,餐厅名称,你的点评,照片,总体评级,署名,联系邮箱,发布授权,restaurant_id,restaurant_name,source';
const PHOTO = 'https://storage.tally.so/private/photo-a.jpg?id=1&accessToken=secret';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\r\n');

const ROWS = {
  textOnly:
    'sub1,resp1,2026-10-01 12:00:00,示例面馆,"汤很浓，面有点软。\n下次还会来",,,小明,ming@example.com,我同意,,,site',
  photoOnly: `sub2,resp2,2026-10-01 13:00:00,示例面馆,,${PHOTO},,,,我同意,,,site`,
  existing: `sub3,resp3,2026-10-02 09:00:00,测试餐厅,"推荐牛肉面",${PHOTO},顶级,,,我同意,r-abc234,测试餐厅,restaurant-page`,
  noConsent: 'sub4,resp4,2026-10-02 10:00:00,示例面馆,好吃,,夯,,,,,,site',
};

const img = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c86' } })
  .jpeg()
  .toBuffer();

/** A fake fetch: Tally photo links return a JPEG; "expired" links return 403. */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes('expired')) return new Response('', { status: 403 });
  if (url.includes('not-image')) return new Response('<html>');
  return new Response(img, { headers: { 'content-type': 'image/jpeg' } });
}) as typeof fetch;

async function setup() {
  const root = await tempDir();
  const restaurantsDir = path.join(root, 'content/restaurants');
  const draftsDir = path.join(root, 'private/drafts');
  const submissionsDir = path.join(root, 'private/submissions');
  const review = '原有点评，不能被覆盖。\n';
  await writeRestaurant(
    restaurantsDir,
    'r-abc234',
    validInfo('r-abc234', { name: '测试餐厅', altNames: ['Test Place'], address: '1 Main St' }),
    { 'review.md': review },
  );
  await writeRestaurant(restaurantsDir, 'r-def567', validInfo('r-def567', { name: '另一家店' }));
  const snapshot = async () => {
    const files = await readdir(restaurantsDir, { recursive: true });
    return Promise.all(
      files.sort().map(async (f) => {
        const full = path.join(restaurantsDir, f);
        return [
          f,
          (await import('node:fs')).statSync(full).isFile() ? await readFile(full, 'utf8') : '',
        ];
      }),
    );
  };
  const run = (subs: Submission[], download = true) =>
    importSubmissions(subs, {
      submissionsDir,
      restaurantsDir,
      draftsDir,
      download,
      fetchImpl: fakeFetch,
    });
  return { root, restaurantsDir, draftsDir, submissionsDir, review, snapshot, run };
}

describe('reading Tally exports', () => {
  it('parses quoted fields, embedded newlines, and a BOM', () => {
    expect(parseCsv('\uFEFFa,b\r\n"x, ""y""","1\n2"\n')).toEqual([
      ['a', 'b'],
      ['x, "y"', '1\n2'],
    ]);
  });

  it('maps columns by question title and hidden-field name', () => {
    const [text, photo, existing, noConsent] = submissionsFromCsv(
      csv(ROWS.textOnly, ROWS.photoOnly, ROWS.existing, ROWS.noConsent),
    );
    expect(text).toMatchObject({
      submissionId: 'sub1',
      restaurantName: '示例面馆',
      review: '汤很浓，面有点软。\n下次还会来',
      photoUrls: [],
      displayName: '小明',
      email: 'ming@example.com',
      consent: true,
      source: 'site',
    });
    expect(text!.ratingAnswer).toBeUndefined();
    expect(photo).toMatchObject({ review: undefined, photoUrls: [PHOTO] });
    expect(existing).toMatchObject({
      restaurantId: 'r-abc234',
      ratingAnswer: '顶级',
      source: 'restaurant-page',
    });
    expect(noConsent!.consent).toBe(false);
  });

  it('reports exports that do not match the form', () => {
    expect(() => submissionsFromCsv('Name,Review\nx,y')).toThrow(/Submission ID/);
    expect(() => submissionsFromCsv('Submission ID,Review\nx,y')).toThrow(/consent/);
  });

  it('reads a submission transcribed from a notification email as JSON', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'email.json');
    await writeFile(
      file,
      JSON.stringify({ submissionId: 'mail1', restaurantName: 'X', review: 'ok', consent: true }),
    );
    expect((await readSubmissions(file))[0]).toMatchObject({
      submissionId: 'mail1',
      photoUrls: [],
    });
    await writeFile(file, JSON.stringify({ submissionId: '../etc', consent: true }));
    await expect(readSubmissions(file)).rejects.toThrow(/submissionId/);
    await writeFile(file, JSON.stringify({ submissionId: 'mail2' }));
    await expect(readSubmissions(file)).rejects.toThrow(/consent/);
  });
});

describe('restaurant identity', () => {
  const known = [
    { id: 'r-abc234', name: '测试餐厅', altNames: ['Test Place'], where: 'content' as const },
    { id: 'r-def567', name: '另一家店', altNames: [], where: 'content' as const },
  ];
  const sub = (extra: Partial<Submission>): Submission => ({
    submissionId: 's',
    photoUrls: [],
    consent: true,
    ...extra,
  });

  it('accepts a valid id with a matching (or alternative) name', () => {
    expect(
      resolveIdentity(sub({ restaurantId: 'r-abc234', restaurantName: 'test place' }), known).kind,
    ).toBe('existing');
  });

  it('flags an id that conflicts with the submitted name', () => {
    const identity = resolveIdentity(
      sub({ restaurantId: 'r-abc234', restaurantName: '另一家店' }),
      known,
    );
    expect(identity).toMatchObject({ kind: 'conflict', candidates: [{ id: 'r-def567' }] });
  });

  it('flags unknown ids instead of trusting them', () => {
    expect(
      resolveIdentity(sub({ restaurantId: 'r-zzz999', restaurantName: '测试餐厅' }), known),
    ).toMatchObject({
      kind: 'unknown-id',
      candidates: [{ id: 'r-abc234' }],
    });
  });

  it('suggests existing restaurants by name and recognizes new ones', () => {
    expect(resolveIdentity(sub({ restaurantName: ' 测试 餐厅 ' }), known).kind).toBe('candidates');
    expect(resolveIdentity(sub({ restaurantName: '新开的店' }), known).kind).toBe('new');
    expect(resolveIdentity(sub({}), known).kind).toBe('unidentified');
  });
});

describe('photo downloads', () => {
  it('downloads Tally photos with names from their content', async () => {
    const dir = await tempDir();
    const [result] = await downloadPhotos([PHOTO], dir, fakeFetch);
    expect(result).toMatchObject({ url: 'https://storage.tally.so/private/photo-a.jpg' });
    expect(path.basename(result!.file!)).toBe('photo-01.jpg');
  });

  it('refuses other hosts, non-images, expired links, and too many photos', async () => {
    const dir = await tempDir();
    const urls = [
      'http://storage.tally.so/a.jpg',
      'https://evil.example/a.jpg',
      'https://storage.tally.so/expired.jpg',
      'https://storage.tally.so/not-image',
      ...Array.from({ length: 10 }, (_, i) => `https://storage.tally.so/${i}.jpg`),
    ];
    const results = await downloadPhotos(urls, dir, fakeFetch);
    expect(results.slice(0, 4).map((r) => r.problem)).toEqual([
      expect.stringMatching(/not an https link on tally.so/),
      expect.stringMatching(/not an https link on tally.so/),
      expect.stringMatching(/HTTP 403/),
      expect.stringMatching(/not a JPEG/),
    ]);
    expect(results.filter((r) => r.file)).toHaveLength(6); // 10 allowed, 4 failed
    expect(results.slice(10).every((r) => /more than 10/.test(r.problem ?? ''))).toBe(true);
    expect((await readdir(dir)).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('never prints signed-link tokens', () => {
    expect(redactUrl(PHOTO)).not.toContain('secret');
  });
});

describe('importing submissions', () => {
  it('imports text-only, photo-only, and mixed submissions privately', async () => {
    const { run, submissionsDir, root } = await setup();
    const results = await run(
      submissionsFromCsv(csv(ROWS.textOnly, ROWS.photoOnly, ROWS.existing)),
    );
    expect(results.map((r) => r.blockers)).toEqual([[], [], []]);
    expect(results.map((r) => r.identity.kind)).toEqual(['new', 'new', 'existing']);
    expect(results.map((r) => r.rating)).toEqual([undefined, undefined, 4]);
    expect(results[1]!.photos[0]!.file).toBe(
      path.join(submissionsDir, 'tally-sub2', 'photo-01.jpg'),
    );
    const saved = JSON.parse(
      await readFile(path.join(submissionsDir, 'tally-sub1/submission.json'), 'utf8'),
    );
    expect(saved.email).toBe('ming@example.com'); // kept privately for contact
    expect(Object.keys(await readLog(submissionsDir))).toEqual(['sub1', 'sub2', 'sub3']);
    // Reports never print contact details or link tokens.
    const report = results.map((r) => formatImport(r, (f) => path.relative(root, f))).join('\n');
    expect(report).not.toContain('ming@example.com');
    expect(report).not.toContain('accessToken');
    expect(report).toContain('contact email provided (private)');
    expect(report).toContain('existing r-abc234 "测试餐厅"');
  });

  it('notes missing optional rating and contact details without blocking', async () => {
    const { run } = await setup();
    const [result] = await run(submissionsFromCsv(csv(ROWS.photoOnly)));
    expect(result!.rating).toBeUndefined();
    expect(result!.blockers).toEqual([]);
    expect(result!.notes.join('\n')).toMatch(/no contact email/);
  });

  it('blocks submissions without consent or content', async () => {
    const { run } = await setup();
    const [noConsent] = await run(submissionsFromCsv(csv(ROWS.noConsent)));
    expect(noConsent!.blockers.join()).toMatch(/no publication consent/);
    const [empty] = await run([
      { submissionId: 'empty', restaurantName: 'X', photoUrls: [], consent: true },
    ]);
    expect(empty!.blockers.join()).toMatch(/neither review text nor photos/);
  });

  it('skips duplicates, even after the raw files are deleted', async () => {
    const { run, submissionsDir } = await setup();
    await run(submissionsFromCsv(csv(ROWS.textOnly)));
    await markSubmission(submissionsDir, 'sub1', 'processed', 'r-new111');
    const { rm } = await import('node:fs/promises');
    await rm(path.join(submissionsDir, 'tally-sub1'), { recursive: true });
    const [again] = await run(submissionsFromCsv(csv(ROWS.textOnly)));
    expect(again!.duplicate).toMatchObject({ status: 'processed', restaurantId: 'r-new111' });
    expect(existsSync(path.join(submissionsDir, 'tally-sub1'))).toBe(false);
    await expect(markSubmission(submissionsDir, 'nope', 'rejected')).rejects.toThrow(
      /not been imported/,
    );
  });

  it('reports unavailable photos and conflicting ids without failing', async () => {
    const { run } = await setup();
    const [result] = await run([
      {
        submissionId: 'c1',
        restaurantId: 'r-abc234',
        restaurantName: '另一家店',
        photoUrls: ['https://storage.tally.so/expired.jpg'],
        consent: true,
      },
    ]);
    expect(result!.identity.kind).toBe('conflict');
    expect(result!.photos[0]!.problem).toMatch(/HTTP 403/);
    expect(result!.notes.join()).toMatch(/not downloaded/);
  });

  it('never changes the public database or creates drafts', async () => {
    const { run, snapshot, restaurantsDir, draftsDir, review } = await setup();
    const before = await snapshot();
    await run(
      submissionsFromCsv(csv(ROWS.textOnly, ROWS.photoOnly, ROWS.existing, ROWS.noConsent)),
    );
    expect(await snapshot()).toEqual(before);
    expect(await readFile(path.join(restaurantsDir, 'r-abc234/review.md'), 'utf8')).toBe(review);
    expect(existsSync(draftsDir)).toBe(false);
  });
});
