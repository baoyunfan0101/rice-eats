import { existsSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  addManualPhoto,
  formatReport,
  importSubmissions,
  markSubmission,
  openSubmission,
  parseCsv,
  readLog,
  readSubmissions,
  resolveIdentity,
  retryPhotos,
  submissionStatus,
  submissionsFromCsv,
  waivePhoto,
  type ImportOptions,
  type Submission,
} from '../../scripts/content/submissions.ts';
import { tempDir, validInfo, writeRestaurant } from './helpers.ts';

// Synthetic Tally CSV export: the columns Tally writes (Submission ID,
// Submitted at, question titles, hidden fields). All data is fictional.
const HEADER =
  'Submission ID,Respondent ID,Submitted at,餐厅名称,你的点评,照片,总体评级,署名,联系邮箱,发布授权,restaurant_id,restaurant_name,source';
const PHOTO = 'https://storage.tally.so/private/photo-a.jpg?id=1&accessToken=secret';
const PHOTO_B = 'https://storage.tally.so/private/photo-b.jpg?accessToken=secret';
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
const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#468' } })
  .png()
  .toBuffer();

/**
 * A fake network. Paths listed in `down` answer 403 (an expired link) until
 * removed; "not-image" answers HTML. Everything else is a JPEG. Requests are
 * counted so tests can check that verified photos are not fetched again.
 */
function fakeNetwork() {
  const down = new Set<string>();
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (down.has(url.pathname)) return new Response('', { status: 403 });
    if (url.pathname.includes('not-image')) return new Response('<html>');
    return new Response(img, { headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
  const lookup = async () => [{ address: '8.8.8.8' }]; // globally routable; mocked DNS
  return { down, requests, fetchImpl, lookup };
}

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
    const files = (await readdir(restaurantsDir, { recursive: true })).sort();
    return Promise.all(
      files.map(async (f) => {
        const full = path.join(restaurantsDir, f);
        return [f, (await stat(full)).isFile() ? await readFile(full, 'utf8') : ''];
      }),
    );
  };
  const net = fakeNetwork();
  const options = (download = true): ImportOptions => ({
    submissionsDir,
    restaurantsDir,
    draftsDir,
    download,
    fetchImpl: net.fetchImpl,
    lookup: net.lookup,
  });
  const run = (subs: Submission[], download = true) => importSubmissions(subs, options(download));
  const dir = (id: string) => path.join(submissionsDir, `tally-${id}`);
  const files = async (id: string) =>
    (await readdir(dir(id))).filter((f) => f.startsWith('photo-')).sort();
  return {
    root,
    restaurantsDir,
    draftsDir,
    submissionsDir,
    review,
    snapshot,
    net,
    options,
    run,
    dir,
    files,
  };
}

const sub = (extra: Partial<Submission>): Submission => ({
  submissionId: 's1',
  restaurantName: '示例面馆',
  photoUrls: [],
  consent: true,
  ...extra,
});
const statuses = (r: { photos: { status: string }[] }) => r.photos.map((p) => p.status);

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

describe('importing submissions', () => {
  it('imports text-only, photo-only, and mixed submissions privately', async () => {
    const { run, submissionsDir, root, dir } = await setup();
    const reports = await run(
      submissionsFromCsv(csv(ROWS.textOnly, ROWS.photoOnly, ROWS.existing)),
    );
    expect(reports.map((r) => r.outcome)).toEqual(['new', 'new', 'new']);
    expect(reports.map((r) => r.blockers)).toEqual([[], [], []]);
    expect(reports.map((r) => r.identity.kind)).toEqual(['new', 'new', 'existing']);
    expect(reports.map((r) => r.rating)).toEqual([undefined, undefined, 4]);
    expect(reports[1]!.photos).toMatchObject([
      { slot: 1, status: 'downloaded', file: 'photo-01.jpg' },
    ]);
    expect(existsSync(path.join(dir('sub2'), 'photo-01.jpg'))).toBe(true);
    const saved = JSON.parse(await readFile(path.join(dir('sub1'), 'submission.json'), 'utf8'));
    expect(saved.email).toBe('ming@example.com'); // kept privately for contact
    const log = await readLog(submissionsDir);
    expect(Object.keys(log)).toEqual(['sub1', 'sub2', 'sub3']);
    expect([log.sub1!.photos, log.sub2!.photos]).toEqual(['none', 'complete']);
    // Reports never print contact details or link tokens.
    const text = reports.map((r) => formatReport(r, (f) => path.relative(root, f))).join('\n');
    expect(text).not.toContain('ming@example.com');
    expect(text).not.toContain('accessToken');
    expect(text).toContain('contact email provided (private)');
    expect(text).toContain('existing r-abc234 "测试餐厅"');
  });

  it('notes missing optional rating and contact details without blocking', async () => {
    const { run } = await setup();
    const [report] = await run(submissionsFromCsv(csv(ROWS.photoOnly)));
    expect(report!.rating).toBeUndefined();
    expect(report!.blockers).toEqual([]);
    expect(report!.notes.join('\n')).toMatch(/no contact email/);
  });

  it('blocks submissions without consent or content, and keeps the consent answer', async () => {
    const { run, dir } = await setup();
    const [noConsent] = await run(submissionsFromCsv(csv(ROWS.noConsent)));
    expect(noConsent!.blockers.join()).toMatch(/no publication consent/);
    const stored = JSON.parse(await readFile(path.join(dir('sub4'), 'submission.json'), 'utf8'));
    expect(stored.consent).toBe(false);
    const [empty] = await run([sub({ submissionId: 'empty' })]);
    expect(empty!.blockers.join()).toMatch(/neither review text nor photos/);
  });

  it('skips a completed duplicate without network requests or new files', async () => {
    const { run, net, files } = await setup();
    await run(submissionsFromCsv(csv(ROWS.photoOnly)));
    const before = net.requests.length;
    const [again] = await run(submissionsFromCsv(csv(ROWS.photoOnly)));
    expect(again!.outcome).toBe('duplicate');
    expect(net.requests.length).toBe(before);
    expect(await files('sub2')).toEqual(['photo-01.jpg']);
  });

  it('skips submissions whose raw files were removed after processing', async () => {
    const { run, submissionsDir, dir } = await setup();
    await run(submissionsFromCsv(csv(ROWS.textOnly)));
    await markSubmission(submissionsDir, 'sub1', 'processed', 'r-new111');
    await rm(dir('sub1'), { recursive: true });
    const [again] = await run(submissionsFromCsv(csv(ROWS.textOnly)));
    expect(again!.outcome).toBe('archived');
    expect(again!.entry).toMatchObject({ status: 'processed', restaurantId: 'r-new111' });
    expect(existsSync(dir('sub1'))).toBe(false);
    await expect(markSubmission(submissionsDir, 'nope', 'rejected')).rejects.toThrow(
      /not been imported/,
    );
  });

  it('keeps the stored submission when a later export differs', async () => {
    const { run, dir } = await setup();
    await run([sub({ review: 'original' })]);
    const [again] = await run([sub({ review: 'changed', consent: false })]);
    expect(again!.notes.join()).toMatch(/differs from the stored submission/);
    const stored = JSON.parse(await readFile(path.join(dir('s1'), 'submission.json'), 'utf8'));
    expect(stored).toMatchObject({ review: 'original', consent: true });
  });

  it('reports conflicting ids without failing', async () => {
    const { run } = await setup();
    const [report] = await run([
      sub({ restaurantId: 'r-abc234', restaurantName: '另一家店', review: 'x' }),
    ]);
    expect(report!.identity.kind).toBe('conflict');
  });

  it('never changes the public database or creates drafts', async () => {
    const { run, snapshot, restaurantsDir, draftsDir, review, net, options } = await setup();
    const before = await snapshot();
    net.down.add('/private/photo-a.jpg');
    await run(
      submissionsFromCsv(csv(ROWS.textOnly, ROWS.photoOnly, ROWS.existing, ROWS.noConsent)),
    );
    net.down.clear();
    await retryPhotos('sub2', options());
    await submissionStatus('sub3', options());
    expect(await snapshot()).toEqual(before);
    expect(await readFile(path.join(restaurantsDir, 'r-abc234/review.md'), 'utf8')).toBe(review);
    expect(existsSync(draftsDir)).toBe(false);
  });
});

describe('photo recovery', () => {
  it('blocks a photo-only submission whose photos all failed, until a retry succeeds', async () => {
    const { run, net, options, files } = await setup();
    net.down.add('/private/photo-a.jpg');
    const [report] = await run(submissionsFromCsv(csv(ROWS.photoOnly)));
    expect(statuses(report!)).toEqual(['failed']);
    expect(report!.photos[0]!.error).toMatch(/HTTP 403/);
    expect(report!.photos[0]!.error).not.toContain('secret');
    expect(report!.blockers.join()).toMatch(/photo-only submission without any retrieved photo/);
    expect(report!.entry!.photos).toBe('incomplete');

    net.down.clear();
    const retried = await retryPhotos('sub2', options());
    expect(statuses(retried)).toEqual(['downloaded']);
    expect(retried.photos[0]!.attempts).toBe(2);
    expect(retried.blockers).toEqual([]);
    expect(retried.entry!.photos).toBe('complete');
    expect(await files('sub2')).toEqual(['photo-01.jpg']);
  });

  it('keeps text and retrieved photos of a partial submission and retries only the missing ones', async () => {
    const { run, net, options, files, submissionsDir } = await setup();
    net.down.add('/private/photo-b.jpg');
    const [report] = await run([sub({ review: '好吃', photoUrls: [PHOTO, PHOTO_B] })]);
    expect(statuses(report!)).toEqual(['downloaded', 'failed']);
    expect(report!.blockers).toEqual([]);
    expect(report!.notes.join()).toMatch(/photo intake incomplete \(photo 2 missing\)/);
    const first = await readFile(path.join(submissionsDir, 'tally-s1/photo-01.jpg'));

    net.down.clear();
    net.requests.length = 0;
    const retried = await retryPhotos('s1', options());
    expect(net.requests).toEqual(['/private/photo-b.jpg']);
    expect(statuses(retried)).toEqual(['downloaded', 'downloaded']);
    expect(await files('s1')).toEqual(['photo-01.jpg', 'photo-02.jpg']);
    expect(await readFile(path.join(submissionsDir, 'tally-s1/photo-01.jpg'))).toEqual(first);

    // Repeating a successful retry changes nothing.
    net.requests.length = 0;
    const again = await retryPhotos('s1', options());
    expect(net.requests).toEqual([]);
    expect(again.photos).toEqual(retried.photos);
    expect(await files('s1')).toEqual(['photo-01.jpg', 'photo-02.jpg']);
  });

  it('resumes an earlier import with missing photos instead of skipping it', async () => {
    const { run } = await setup();
    const [skipped] = await run([sub({ photoUrls: [PHOTO] })], false);
    expect(statuses(skipped!)).toEqual(['pending']);
    expect(skipped!.entry!.photos).toBe('incomplete');
    const [resumed] = await run([sub({ photoUrls: [PHOTO] })]);
    expect(resumed!.outcome).toBe('resumed');
    expect(statuses(resumed!)).toEqual(['downloaded']);
  });

  it('recovers after an import was interrupted', async () => {
    const { run, dir, net, options } = await setup();
    await run([sub({ photoUrls: [PHOTO, PHOTO_B] })]);
    // Simulate a crash: the second photo was renamed into place but the
    // state still says pending, and the log entry was never written.
    const state = JSON.parse(await readFile(path.join(dir('s1'), 'photos.json'), 'utf8'));
    state[1] = { slot: 2, status: 'pending', attempts: 1 };
    await writeFile(path.join(dir('s1'), 'photos.json'), JSON.stringify(state));
    await rm(path.join(path.dirname(dir('s1')), 'tally-log.json'));
    net.requests.length = 0;
    const [report] = await run([sub({ photoUrls: [PHOTO, PHOTO_B] })]);
    expect(report!.outcome).toBe('new');
    expect(net.requests).toEqual([]); // the leftover file was verified and adopted
    expect(statuses(report!)).toEqual(['downloaded', 'downloaded']);
    expect((await submissionStatus('s1', options())).entry!.photos).toBe('complete');
  });

  it('detects deleted or corrupted photos and downloads them again', async () => {
    const { run, dir, options, files } = await setup();
    await run([sub({ photoUrls: [PHOTO, PHOTO_B] })]);
    await rm(path.join(dir('s1'), 'photo-01.jpg'));
    await writeFile(path.join(dir('s1'), 'photo-02.jpg'), 'corrupted');
    const status = await submissionStatus('s1', options());
    expect(statuses(status)).toEqual(['failed', 'failed']);
    expect(status.photos.map((p) => p.error)).toEqual([
      expect.stringMatching(/file is missing/),
      expect.stringMatching(/not a JPEG/),
    ]);
    expect(status.entry!.photos).toBe('incomplete');
    const retried = await retryPhotos('s1', options());
    expect(statuses(retried)).toEqual(['downloaded', 'downloaded']);
    expect(await files('s1')).toEqual(['photo-01.jpg', 'photo-02.jpg']);
  });

  it('accepts a photo recovered by hand after validating it', async () => {
    const { run, net, submissionsDir, options, files } = await setup();
    net.down.add('/private/photo-a.jpg');
    await run([sub({ photoUrls: [PHOTO] })]);
    const { dir, submission } = await openSubmission(submissionsDir, 's1');
    const work = await tempDir();
    await writeFile(path.join(work, 'not-a-photo.jpg'), 'hello');
    await expect(
      addManualPhoto(dir, submission, 1, path.join(work, 'not-a-photo.jpg')),
    ).rejects.toThrow(/not a JPEG/);
    await expect(addManualPhoto(dir, submission, 3, path.join(work, 'x'))).rejects.toThrow(
      /no photo 3/,
    );
    await writeFile(path.join(work, 'from-tally.png'), png);
    expect(
      await addManualPhoto(dir, submission, 1, path.join(work, 'from-tally.png')),
    ).toMatchObject({
      status: 'recovered',
      file: 'photo-01.png',
    });
    // The same file again is a no-op; a different one never replaces it.
    await addManualPhoto(dir, submission, 1, path.join(work, 'from-tally.png'));
    await writeFile(path.join(work, 'other.jpg'), img);
    await expect(addManualPhoto(dir, submission, 1, path.join(work, 'other.jpg'))).rejects.toThrow(
      /already stored/,
    );
    net.requests.length = 0;
    const status = await retryPhotos('s1', options());
    expect(net.requests).toEqual([]);
    expect(status.blockers).toEqual([]);
    expect(status.entry!.photos).toBe('complete');
    expect(await files('s1')).toEqual(['photo-01.png']);
  });

  it('lets the maintainer proceed without a missing photo', async () => {
    const { run, net, submissionsDir, options } = await setup();
    net.down.add('/private/photo-b.jpg');
    await run([sub({ review: 'ok', photoUrls: [PHOTO, PHOTO_B] })]);
    const { dir, submission } = await openSubmission(submissionsDir, 's1');
    await waivePhoto(dir, submission, 2);
    await expect(waivePhoto(dir, submission, 1)).rejects.toThrow(/downloaded; nothing to waive/);
    const status = await submissionStatus('s1', options());
    expect(statuses(status)).toEqual(['downloaded', 'waived']);
    expect(status.entry!.photos).toBe('complete');
    expect(status.notes.join()).not.toMatch(/incomplete/);
  });

  it('never fetches more than 10 photos or links outside Tally', async () => {
    const { run, net } = await setup();
    const urls = [
      'https://evil.example/a.jpg',
      'https://storage.tally.so/private/not-image',
      ...Array.from({ length: 10 }, (_, i) => `https://storage.tally.so/private/${i}.jpg`),
    ];
    const [report] = await run([sub({ photoUrls: urls })]);
    expect(report!.photos.slice(0, 2).map((p) => p.error)).toEqual([
      expect.stringMatching(/not a trusted Tally file host/),
      expect.stringMatching(/not a JPEG/),
    ]);
    expect(statuses(report!).slice(10)).toEqual(['excluded', 'excluded']);
    expect(net.requests).not.toContain('/a.jpg');
    expect(net.requests).toHaveLength(9); // slots 2-10
  });

  it('rejects a non-image served after a redirect', async () => {
    const { options, dir } = await setup();
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes('photo-a')
        ? new Response(null, { status: 302, headers: { location: 'https://tally.so/f/page' } })
        : new Response('<html>login</html>')) as typeof fetch;
    const [report] = await importSubmissions([sub({ photoUrls: [PHOTO] })], {
      ...options(),
      fetchImpl,
    });
    expect(report!.photos[0]).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/not a JPEG/),
    });
    expect((await readdir(dir('s1'))).sort()).toEqual(['photos.json', 'submission.json']);
  });

  it('cleans up temporary files after failures', async () => {
    const { run, dir } = await setup();
    await run([sub({ photoUrls: ['https://storage.tally.so/private/not-image'] })]);
    expect((await readdir(dir('s1'))).sort()).toEqual(['photos.json', 'submission.json']);
  });
});
