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
  type Identity,
  type ImportOptions,
  type Submission,
} from '../../scripts/content/submissions.ts';
import { tempDir, validInfo, writeRestaurant } from './helpers.ts';

// Synthetic Tally CSV export: the columns Tally writes (Submission ID,
// Submitted at, question titles, hidden fields). All data is fictional.
const COLUMNS = [
  'Submission ID',
  'Respondent ID',
  'Submitted at',
  '你的点评',
  '照片',
  '菜品1 名称',
  '菜品1 评价',
  '菜品1 照片',
  '菜品1 点评',
  '菜品2 名称',
  '菜品2 评价',
  '菜品2 照片',
  '菜品2 点评',
  '总体评级',
  '署名',
  '联系邮箱',
  '发布授权',
  'restaurant_id',
  'restaurant_name',
  'restaurant_lat',
  'restaurant_lng',
  'restaurant_address',
  'poi_provider',
  'poi_id',
  'selection_method',
  'source',
];
const PHOTO = 'https://storage.tally.so/private/photo-a.jpg?id=1&accessToken=secret';
const PHOTO_B = 'https://storage.tally.so/private/photo-b.jpg?accessToken=secret';
const PHOTO_C = 'https://storage.tally.so/private/photo-c.jpg?accessToken=secret';
const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** One CSV row: the given columns, everything else empty. */
const row = (values: Record<string, string>) =>
  COLUMNS.map((c) => quote(values[c] ?? '')).join(',');
const csv = (...rows: string[]) => [COLUMNS.join(','), ...rows].join('\r\n');
const CONSENT = '我同意：我有权提交这些文字和照片，并授权 Rice吃啥 审核。';

const ROWS = {
  textOnly: row({
    'Submission ID': 'sub1',
    'Submitted at': '2026-10-01 12:00:00',
    restaurant_name: '示例面馆',
    restaurant_lat: '29.730000',
    restaurant_lng: '-95.410000',
    restaurant_address: '9 Elm St',
    poi_provider: 'geoapify',
    poi_id: '51abcdef',
    selection_method: 'poi',
    你的点评: '汤很浓，面有点软。\n下次还会来',
    署名: '小明',
    联系邮箱: 'ming@example.com',
    发布授权: CONSENT,
    source: 'site',
  }),
  photoOnly: row({
    'Submission ID': 'sub2',
    restaurant_name: 'Sample Noodles',
    selection_method: 'manual',
    照片: PHOTO,
    发布授权: CONSENT,
    source: 'site',
  }),
  existing: row({
    'Submission ID': 'sub3',
    你的点评: '推荐牛肉面',
    照片: PHOTO,
    总体评级: '😘 顶级',
    发布授权: CONSENT,
    restaurant_id: 'r-abc234',
    restaurant_name: '测试餐厅',
    restaurant_lat: '29.72',
    restaurant_lng: '-95.4',
    selection_method: 'existing',
    source: 'restaurant-page',
  }),
  noConsent: row({
    'Submission ID': 'sub4',
    restaurant_name: '示例面馆',
    你的点评: '好吃',
    总体评级: '夯',
    source: 'site',
  }),
  dishes: row({
    'Submission ID': 'sub5',
    restaurant_name: '示例面馆',
    照片: PHOTO_C,
    '菜品1 名称': '牛肉面',
    '菜品1 评价': '🔥 推荐',
    '菜品1 照片': `${PHOTO}, ${PHOTO_B}`,
    '菜品1 点评': '汤头浓',
    '菜品2 名称': '煎饺',
    '菜品2 评价': '避雷',
    发布授权: CONSENT,
    source: 'site',
  }),
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
  await writeRestaurant(
    restaurantsDir,
    'r-def567',
    validInfo('r-def567', { name: '另一家店', location: { lat: 29.7, lng: -95.3 } }),
  );
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
  dishes: [],
  keywords: [],
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
      restaurantAddress: '9 Elm St',
      restaurantLocation: { lat: 29.73, lng: -95.41 },
      poi: { provider: 'geoapify', id: '51abcdef' },
      selectionMethod: 'poi',
      review: '汤很浓，面有点软。\n下次还会来',
      photoUrls: [],
      displayName: '小明',
      email: 'ming@example.com',
      consent: true,
      source: 'site',
    });
    expect(text!.ratingAnswer).toBeUndefined();
    expect(photo).toMatchObject({
      restaurantName: 'Sample Noodles',
      selectionMethod: 'manual',
      review: undefined,
      photoUrls: [PHOTO],
      dishes: [],
    });
    expect(existing).toMatchObject({
      restaurantId: 'r-abc234',
      restaurantName: '测试餐厅',
      restaurantLocation: { lat: 29.72, lng: -95.4 },
      selectionMethod: 'existing',
      ratingAnswer: '😘 顶级',
      source: 'restaurant-page',
    });
    expect(photo!.restaurantLocation).toBeUndefined();
    expect(photo!.poi).toBeUndefined();
    expect(noConsent!.consent).toBe(false);
  });

  it('keeps invalid coordinates out of the location', () => {
    const [s] = submissionsFromCsv(
      csv(
        row({
          'Submission ID': 'bad',
          restaurant_name: 'X',
          restaurant_lat: '95',
          restaurant_lng: 'abc',
          发布授权: CONSENT,
        }),
      ),
    );
    expect(s!.restaurantLocation).toBeUndefined();
    expect(s!.restaurantLocationRaw).toBe('95,abc');
  });

  it('reads dish groups with their own photos', () => {
    const [s] = submissionsFromCsv(csv(ROWS.dishes));
    expect(s!.photoUrls).toEqual([PHOTO_C]);
    expect(s!.dishes).toEqual([
      { name: '牛肉面', verdictAnswer: '🔥 推荐', comment: '汤头浓', photoUrls: [PHOTO, PHOTO_B] },
      { name: '煎饺', verdictAnswer: '避雷', photoUrls: [] },
    ]);
  });

  it('reads the current form titles with "（选填）" and the new consent text', () => {
    const titled = (c: string) =>
      /^(你的点评|照片|署名|联系邮箱)$|^菜品\d+ (照片|点评)$/.test(c) ? `${c}（选填）` : c;
    const header = COLUMNS.map(titled);
    const values: Record<string, string> = {
      'Submission ID': 'sub-new-titles',
      总体评级: '🫤 NPC',
      你的点评: '还行',
      照片: PHOTO,
      '菜品1 名称': '煎饺',
      '菜品1 评价': '💣 避雷',
      '菜品1 照片': PHOTO_B,
      '菜品1 点评': '太油',
      署名: '小红',
      联系邮箱: 'hong@example.com',
      发布授权:
        '我同意并确认：投稿基于真实用餐体验，内容真实、客观，不含虚假宣传、恶意贬损或未披露的商业推广及利益关系。',
    };
    const line = COLUMNS.map((c) => quote(values[c] ?? '')).join(',');
    const [s] = submissionsFromCsv([header.map(quote).join(','), line].join('\r\n'));
    expect(s).toMatchObject({
      ratingAnswer: '🫤 NPC',
      review: '还行',
      photoUrls: [PHOTO],
      displayName: '小红',
      email: 'hong@example.com',
      consent: true,
      dishes: [{ name: '煎饺', verdictAnswer: '💣 避雷', comment: '太油', photoUrls: [PHOTO_B] }],
    });
  });

  it('ignores the untitled "add a dish" checkbox columns', () => {
    // The 菜品N 添加 questions have no title in the form, so an export may
    // show them blank, as "Untitled …", or by their option text.
    const extra = ['', 'Untitled checkboxes field (＋ 添加一道菜)', '(＋ 再添加一道菜)'];
    const header = [...COLUMNS.slice(0, 5), ...extra, ...COLUMNS.slice(5)];
    const values: Record<string, string> = {
      'Submission ID': 'sub-untitled',
      你的点评: '不错',
      '菜品1 名称': '牛肉面',
      '菜品1 评价': '🔥 推荐',
      发布授权: CONSENT,
    };
    const line = header
      .map((c, i) => quote(i >= 5 && i < 5 + extra.length ? 'true' : (values[c] ?? '')))
      .join(',');
    const [s] = submissionsFromCsv([header.map(quote).join(','), line].join('\r\n'));
    expect(s!.review).toBe('不错');
    expect(s!.dishes).toEqual([{ name: '牛肉面', verdictAnswer: '🔥 推荐', photoUrls: [] }]);
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
      dishes: [],
    });
    await writeFile(file, JSON.stringify({ submissionId: '../etc', consent: true }));
    await expect(readSubmissions(file)).rejects.toThrow(/submissionId/);
    await writeFile(file, JSON.stringify({ submissionId: 'mail2' }));
    await expect(readSubmissions(file)).rejects.toThrow(/consent/);
  });
});

describe('restaurant identity', () => {
  const at = (lat: number, lng: number) => ({ lat, lng });
  const known = [
    {
      id: 'r-abc234',
      name: '测试餐厅',
      names: ['测试餐厅', 'Test Place'],
      location: at(29.72, -95.4),
      where: 'content' as const,
    },
    {
      id: 'r-def567',
      name: '另一家店',
      names: ['另一家店'],
      location: at(29.7205, -95.4005),
      where: 'content' as const,
    },
    // A branch of the same chain far away.
    {
      id: 'r-ghi890',
      name: '测试餐厅',
      names: ['测试餐厅'],
      location: at(29.6, -95.6),
      where: 'content' as const,
    },
  ];
  const sub = (extra: Partial<Submission>): Submission => ({
    submissionId: 's',
    photoUrls: [],
    dishes: [],
    keywords: [],
    consent: true,
    ...extra,
  });
  const ids = (identity: Identity) =>
    'candidates' in identity ? identity.candidates.map((c) => c.restaurant.id) : undefined;

  it('accepts a valid id with a matching (or alternative) name', () => {
    expect(
      resolveIdentity(sub({ restaurantId: 'r-abc234', restaurantName: 'test place' }), known).kind,
    ).toBe('existing');
    expect(resolveIdentity(sub({ restaurantId: 'r-abc234' }), known).kind).toBe('existing');
  });

  it('flags an id that conflicts with the submitted name or location', () => {
    const named = resolveIdentity(
      sub({ restaurantId: 'r-abc234', restaurantName: '另一家店' }),
      known,
    );
    expect(named.kind).toBe('conflict');
    expect(ids(named)).toEqual(['r-def567']);
    const moved = resolveIdentity(
      sub({
        restaurantId: 'r-abc234',
        restaurantName: '测试餐厅',
        restaurantLocation: at(29.6, -95.6),
      }),
      known,
    );
    expect(moved).toMatchObject({ kind: 'conflict', reason: expect.stringMatching(/location/) });
  });

  it('flags unknown ids instead of trusting them', () => {
    const identity = resolveIdentity(
      sub({ restaurantId: 'r-zzz999', restaurantName: '测试餐厅' }),
      known,
    );
    expect(identity.kind).toBe('unknown-id');
    expect(ids(identity)).toEqual(expect.arrayContaining(['r-abc234', 'r-ghi890']));
  });

  it('matches a POI linked by an earlier reviewed submission', () => {
    const poi = { provider: 'geoapify', id: 'p1' };
    const index = new Map([['geoapify:p1', 'r-def567']]);
    expect(resolveIdentity(sub({ restaurantName: 'Renamed', poi }), known, index)).toMatchObject({
      kind: 'poi-match',
      restaurant: { id: 'r-def567' },
    });
    // An unknown POI falls back to location and names.
    expect(resolveIdentity(sub({ restaurantName: '新开的店', poi }), known).kind).toBe('new');
  });

  it('suggests nearby restaurants and same-name branches, never merging on the name alone', () => {
    const nearby = resolveIdentity(
      sub({ restaurantName: ' 测试 餐厅 ', restaurantLocation: at(29.7201, -95.4001) }),
      known,
    );
    expect(nearby.kind).toBe('candidates');
    // Sorted by distance: the same-name restaurant here, a neighbor, then the far branch.
    expect(ids(nearby)).toEqual(['r-abc234', 'r-def567', 'r-ghi890']);
    expect(nearby).toMatchObject({
      candidates: [{ nameMatch: true }, { nameMatch: false }, { nameMatch: true }],
    });
    const nameOnly = resolveIdentity(sub({ restaurantName: '测试餐厅' }), known);
    expect(nameOnly.kind).toBe('candidates');
    expect(ids(nameOnly)).toEqual(['r-abc234', 'r-ghi890']);
  });

  it('recognizes new restaurants and missing identities', () => {
    expect(
      resolveIdentity(sub({ restaurantName: '新开的店', restaurantLocation: at(30, -95) }), known)
        .kind,
    ).toBe('new');
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

  it('keeps dish photos attached to their dish', async () => {
    const { run, root } = await setup();
    const [report] = await run(submissionsFromCsv(csv(ROWS.dishes)));
    expect(report!.blockers).toEqual([]);
    expect(report!.photos.map((p) => [p.slot, p.dish, p.status, p.file])).toEqual([
      [1, undefined, 'downloaded', 'photo-01.jpg'],
      [2, 1, 'downloaded', 'photo-02.jpg'],
      [3, 1, 'downloaded', 'photo-03.jpg'],
    ]);
    const text = formatReport(report!, (f) => path.relative(root, f));
    expect(text).toContain('dish 1  "牛肉面"; verdict 1 (推荐); comment; photo 2, 3');
    expect(text).toContain('dish 2  "煎饺"; verdict -1 (避雷); no comment; no photo');
    expect(text).toMatch(/photo-02\.jpg \(1 attempt\) \[dish 1\]/);
  });

  it('accepts a dish-only submission and limits photos per dish', async () => {
    const { run } = await setup();
    const many = Array.from({ length: 4 }, (_, i) => `https://storage.tally.so/private/d${i}.jpg`);
    const [report] = await run([sub({ dishes: [{ name: '凉皮', photoUrls: many }] })]);
    expect(report!.blockers).toEqual([]);
    expect(statuses(report!)).toEqual(['downloaded', 'downloaded', 'downloaded', 'excluded']);
    expect(report!.photos[3]!.error).toMatch(/more than 3 photos for dish 1/);
    const [unnamed] = await run([
      sub({ submissionId: 's2', review: 'ok', dishes: [{ verdictAnswer: '推荐', photoUrls: [] }] }),
    ]);
    expect(unnamed!.notes.join()).toMatch(/dish 1 has no name/);
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
    expect(empty!.blockers.join()).toMatch(
      /neither a valid rating, review text, dishes, nor photos/,
    );
  });

  it('accepts a rating-only submission, but not an invalid rating alone', async () => {
    const { run } = await setup();
    const [ratingOnly] = await run([
      sub({ submissionId: 'rating-only', ratingAnswer: '🤤 人上人' }),
    ]);
    expect(ratingOnly!.blockers).toEqual([]);
    expect(ratingOnly!.rating).toBeDefined();
    // The review text is optional now: no warning for leaving it out.
    expect(ratingOnly!.notes.join('\n')).not.toMatch(/review text|no overall rating/);
    const [invalid] = await run([sub({ submissionId: 'bad-rating', ratingAnswer: '还行吧' })]);
    expect(invalid!.rating).toBeUndefined();
    expect(invalid!.blockers.join()).toMatch(/neither a valid rating/);
    expect(invalid!.notes.join('\n')).toMatch(/"还行吧" is not one of the five levels/);
  });

  it('keeps older text-only submissions without a rating', async () => {
    const { run } = await setup();
    const [old] = await run(submissionsFromCsv(csv(ROWS.textOnly)));
    expect(old!.blockers).toEqual([]);
    expect(old!.notes.join('\n')).toMatch(/no overall rating \(optional in older form versions\)/);
  });

  it('flags promotion, undisclosed ties, and near-identical reviews for the editor', async () => {
    const { run } = await setup();
    const promo = '新店开业全场八折，欢迎大家光临，关注公众号领优惠码！牛肉面真的很好吃。';
    const reports = await run([
      sub({ submissionId: 'promo', review: promo, ratingAnswer: '🥵 夯' }),
      sub({ submissionId: 'copy', review: `${promo} `, ratingAnswer: '🥵 夯' }),
      sub({
        submissionId: 'owner',
        review: '我是这家店的老板，我们的面都是手工做的。',
        ratingAnswer: '🥵 夯',
      }),
      sub({
        submissionId: 'plain',
        review: '汤头浓郁，面条筋道，就是排队有点久。',
        ratingAnswer: '🤤 人上人',
      }),
    ]);
    const notes = (id: string) =>
      reports.find((r) => r.submission.submissionId === id)!.notes.join('\n');
    expect(notes('promo')).toMatch(/reads like promotion/);
    expect(notes('promo')).toMatch(/nearly identical to submission copy/);
    expect(notes('copy')).toMatch(/nearly identical to submission promo/);
    expect(notes('owner')).toMatch(/relationship with the restaurant/);
    expect(notes('plain')).not.toMatch(/review check/);
    // Hints never block a draft on their own.
    expect(reports.every((r) => r.blockers.length === 0)).toBe(true);
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

  it('keeps the raw submission whatever its status', async () => {
    const { run, submissionsDir, dir, files } = await setup();
    await run(submissionsFromCsv(csv(ROWS.textOnly, ROWS.photoOnly)));
    const stored = async (id: string) => [
      await readFile(path.join(dir(id), 'submission.json'), 'utf8'),
      ...(await files(id)),
    ];
    const before = { sub1: await stored('sub1'), sub2: await stored('sub2') };
    for (const status of ['drafted', 'deferred', 'processed', 'rejected', 'imported'] as const) {
      await markSubmission(submissionsDir, 'sub1', status, 'r-new111');
      await markSubmission(submissionsDir, 'sub2', status);
      expect(await stored('sub1')).toEqual(before.sub1);
      expect(await stored('sub2')).toEqual(before.sub2);
    }
  });

  it('reports a submission whose raw files are missing (erased on request) without importing it again', async () => {
    const { run, submissionsDir, dir } = await setup();
    await run(submissionsFromCsv(csv(ROWS.textOnly)));
    await markSubmission(submissionsDir, 'sub1', 'processed', 'r-new111');
    await rm(dir('sub1'), { recursive: true });
    const [again] = await run(submissionsFromCsv(csv(ROWS.textOnly)));
    expect(again!.outcome).toBe('missing');
    expect(again!.entry).toMatchObject({ status: 'processed', restaurantId: 'r-new111' });
    expect(formatReport(again!, (f) => f)).toMatch(/raw files are missing.*private backup/);
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

  it('remembers reviewed POIs privately and matches later submissions of the same place', async () => {
    const { run, submissionsDir, root } = await setup();
    const [first] = await run(submissionsFromCsv(csv(ROWS.textOnly)));
    expect(first!.identity.kind).toBe('new');
    expect((await readLog(submissionsDir)).sub1!.poi).toBe('geoapify:51abcdef');
    const text = formatReport(first!, (f) => path.relative(root, f));
    expect(text).toContain(
      'method poi; name "示例面馆"; address "9 Elm St"; at 29.730000,-95.410000',
    );
    // Only a reviewed link counts: an imported submission does not.
    const poi = { provider: 'geoapify', id: '51abcdef' };
    const [early] = await run([
      sub({ submissionId: 'later1', restaurantName: 'Renamed', poi, review: 'x' }),
    ]);
    expect(early!.identity.kind).toBe('new');
    await markSubmission(submissionsDir, 'sub1', 'drafted', 'r-def567');
    const [later] = await run([
      sub({ submissionId: 'later2', restaurantName: 'Renamed', poi, review: 'x' }),
    ]);
    expect(later!.identity).toMatchObject({ kind: 'poi-match', restaurant: { id: 'r-def567' } });
  });

  it('notes restaurants that need their location verified', async () => {
    const { run } = await setup();
    const [nameOnly, marked, bad] = await run([
      sub({ submissionId: 'm1', selectionMethod: 'manual', review: 'x' }),
      sub({
        submissionId: 'm2',
        selectionMethod: 'manual',
        restaurantLocation: { lat: 29.75, lng: -95.35 },
        review: 'x',
      }),
      sub({
        submissionId: 'm3',
        selectionMethod: 'other',
        restaurantLocationRaw: '95,0',
        review: 'x',
      }),
    ]);
    expect(nameOnly!.notes.join('\n')).toMatch(/name only, no location/);
    expect(marked!.notes.join('\n')).toMatch(/added by hand/);
    expect(bad!.notes.join('\n')).toMatch(/unknown selection method "other"/);
    expect(bad!.notes.join('\n')).toMatch(/invalid restaurant coordinates "95,0"/);
    expect([nameOnly, marked, bad].map((r) => r!.blockers)).toEqual([[], [], []]);
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
