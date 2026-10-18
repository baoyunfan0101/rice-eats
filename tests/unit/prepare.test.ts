import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { publishContributors } from '../../scripts/content/contributors.ts';
import { moveDraft } from '../../scripts/content/intake.ts';
import { runPipeline } from '../../scripts/content/pipeline.ts';
import {
  markOutcome,
  prepareSubmission,
  rejectionProblems,
  rejectSubmission,
  type PrepareOptions,
} from '../../scripts/content/prepare.ts';
import { findSensitiveMetadata } from '../../scripts/content/privacy.ts';
import {
  importSubmissions,
  markSubmission,
  readLog,
  submissionsFromCsv,
  type LogStatus,
  type Submission,
} from '../../scripts/content/submissions.ts';
import { publishTags } from '../../scripts/content/tags.ts';
import { makeImage, tempDir, writeRestaurant } from './helpers.ts';

// End-to-end tests of the deterministic submission pipeline on a temporary
// database: import (Tally CSV) -> prepare (private draft) -> promote. All data
// is fictional and the network is faked.

const COLUMNS = [
  'Submission ID',
  'Respondent ID',
  'Submitted at',
  '总体评级',
  '你的点评（选填）',
  '照片（选填）',
  '菜品1 名称',
  '菜品1 评价',
  '菜品1 照片（选填）',
  '菜品1 点评（选填）',
  '菜品2 名称',
  '菜品2 评价',
  '菜品2 照片（选填）',
  '菜品2 点评（选填）',
  '署名（选填）',
  '联系邮箱（选填）',
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
  '标签（选填）',
  '餐厅别名（选填）',
];
const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const row = (values: Record<string, string>) =>
  COLUMNS.map((c) => quote(values[c] ?? '')).join(',');
const csv = (...rows: string[]) => [COLUMNS.join(','), ...rows].join('\r\n');
const CONSENT = '我同意并确认：投稿基于真实用餐体验……';
const photo = (name: string) =>
  `https://storage.tally.so/private/${name}.jpg?id=x&accessToken=secret`;

/** A realistic new-format export row: a new restaurant, keywords, two dishes with several photos each. */
const NEW_RESTAURANT = {
  'Submission ID': 'mAbC12',
  'Respondent ID': 'r1',
  'Submitted at': '2026-10-14 19:30:00',
  总体评级: '😘 顶级',
  '你的点评（选填）': '汤底很浓，环境安静。\n适合两个人慢慢吃。',
  '照片（选填）': `${photo('room')}`,
  '菜品1 名称': '小笼包',
  '菜品1 评价': '🔥 推荐',
  '菜品1 照片（选填）': `${photo('xlb-a')}, ${photo('xlb-b')}, ${photo('xlb-c')}`,
  '菜品1 点评（选填）': '皮薄汁多',
  '菜品2 名称': '红烧肉',
  '菜品2 评价': '💣 避雷',
  '菜品2 照片（选填）': `${photo('hsr-d')}, ${photo('hsr-e')}`,
  '署名（选填）': '小明',
  '联系邮箱（选填）': 'ming@example.com',
  发布授权: CONSENT,
  restaurant_name: '示例汤包馆',
  restaurant_lat: '29.717400',
  restaurant_lng: '-95.401800',
  restaurant_address: '6100 Main St, Houston',
  poi_provider: 'osm',
  poi_id: 'node/1001',
  selection_method: 'poi',
  source: 'site',
  '标签（选填）': '适合情侣约会，约会圣地、很安静, 适合带宠物\n适合聚餐',
};

/** Fake network: a distinct JPEG per Tally path, and an Overpass answer for node/1001. */
function fakeNetwork() {
  const down = new Set<string>();
  const requests: string[] = [];
  /** What Overpass answers (the selected listing); tests change it. */
  const places: Record<string, unknown>[] = [
    {
      type: 'node',
      id: 1001,
      lat: 29.7174,
      lon: -95.4018,
      tags: {
        name: '示例汤包馆',
        'name:en': 'Example Dumpling House',
        amenity: 'restaurant',
        cuisine: 'chinese;shanghainese',
        website: 'https://dumplings.example/',
      },
    },
  ];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(`${url.hostname}${url.pathname}`);
    if (down.has(url.pathname)) return new Response('', { status: 403 });
    if (url.hostname === 'overpass-api.de') return Response.json({ elements: places });
    let hash = 0;
    for (const c of url.pathname) hash = (hash * 31 + c.charCodeAt(0)) % 255;
    const body = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: hash, g: 255 - hash, b: 90 } },
    })
      .jpeg()
      .withExif({ IFD0: { Make: 'ExamplePhone' } })
      .toBuffer();
    return new Response(body, { headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
  const lookup = async () => [{ address: '8.8.8.8' }];
  return { down, requests, places, fetchImpl, lookup };
}

/** Changes the draft's address by hand, as the maintainer would. */
async function editAddress(
  t: { readJson: (file: string) => Promise<Record<string, unknown>> },
  draft: string,
  address: string,
) {
  const file = path.join(draft, 'info.json');
  await writeFile(file, JSON.stringify({ ...(await t.readJson(file)), address }, null, 2));
}

async function setup() {
  const root = await tempDir();
  const p = (...parts: string[]) => path.join(root, ...parts);
  await writeFile(
    p('tags.json'),
    JSON.stringify([
      { id: 'date', label: '适合约会', aliases: ['约会', '适合情侣约会'] },
      { id: 'group', label: '适合聚餐' },
      { id: 'quiet', label: '安静' },
    ]),
  );
  await writeFile(p('contributors.json'), JSON.stringify([{ id: 'u-001', name: '老作者' }]));
  const net = fakeNetwork();
  const options: PrepareOptions = {
    submissionsDir: p('private/submissions'),
    restaurantsDir: p('content/restaurants'),
    draftsDir: p('private/drafts'),
    contributorFiles: {
      publicFile: p('contributors.json'),
      privateFile: p('private/contributors.json'),
    },
    tagFiles: { publicFile: p('tags.json'), privateFile: p('private/tags.json') },
    cacheDir: p('private/cache'),
    imageCacheDir: p('.cache/images'),
    fetchImpl: net.fetchImpl,
    lookup: net.lookup,
  };
  const importCsv = (text: string) =>
    importSubmissions(submissionsFromCsv(text), {
      submissionsDir: options.submissionsDir,
      restaurantsDir: options.restaurantsDir,
      draftsDir: options.draftsDir,
      fetchImpl: net.fetchImpl,
      lookup: net.lookup,
    });
  const prepare = (id: string, extra: Partial<PrepareOptions> = {}) =>
    prepareSubmission(id, { ...options, ...extra });
  const mark = (id: string, status: LogStatus, resolved = false, stateLost?: string) =>
    markOutcome(id, status, { ...options, resolved, stateLost });
  const reject = (id: string, resolved = false, stateLost?: string) =>
    mark(id, 'rejected', resolved, stateLost);
  const readJson = async (file: string) =>
    JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const listing = async (dir: string) =>
    existsSync(dir) ? (await readdir(dir, { recursive: true })).map(String).sort() : [];
  return { root, p, net, options, importCsv, prepare, mark, reject, readJson, listing };
}

const validate = (t: Awaited<ReturnType<typeof setup>>) =>
  runPipeline({
    restaurantsDir: t.options.restaurantsDir,
    contributorsFile: t.options.contributorFiles.publicFile,
    draftsDir: t.options.draftsDir,
    privateContributorsFile: t.options.contributorFiles.privateFile,
    tagsFile: t.options.tagFiles.publicFile,
    privateTagsFile: t.options.tagFiles.privateFile,
    source: 'content',
    includeDrafts: true,
    base: '/',
    cacheDir: t.options.imageCacheDir,
  });

describe('submission import (new export format)', () => {
  it('reads the tags and the restaurant aliases from their questions, split at commas and 、', () => {
    const [s] = submissionsFromCsv(
      csv(
        row({ ...NEW_RESTAURANT, '餐厅别名（选填）': 'Example Dumpling House、 汤包馆 ，汤包馆' }),
      ),
    );
    expect(s!.keywords).toEqual(['适合情侣约会', '约会圣地', '很安静', '适合带宠物', '适合聚餐']);
    expect(s!.restaurantAltNames).toEqual(['Example Dumpling House', '汤包馆']);
    expect(s!.dishes.map((d) => d.photoUrls.length)).toEqual([3, 2]);
    const old = COLUMNS.filter((c) => c !== '标签（选填）');
    const [withoutQuestion] = submissionsFromCsv(
      [
        old.join(','),
        old.map((c) => quote((NEW_RESTAURANT as Record<string, string>)[c] ?? '')).join(','),
      ].join('\n'),
    );
    expect(withoutQuestion!.keywords).toEqual([]);
    expect(withoutQuestion!.restaurantAltNames).toEqual([]);
  });
});

describe('prepare', () => {
  it('turns a new-restaurant submission into a complete private draft', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const report = await t.prepare('mAbC12');
    expect(report.outcome).toBe('drafted');
    expect(report.mode).toBe('new');
    expect(report.updatesReview).toBe(false);
    const id = report.restaurantId!;
    const draft = t.p('private/drafts', id);
    const info = await t.readJson(path.join(draft, 'info.json'));

    // Fixed mappings, done without a model.
    expect(info).toMatchObject({
      id,
      status: 'draft',
      name: '示例汤包馆',
      address: '6100 Main St, Houston',
      location: { lat: 29.7174, lng: -95.4018 },
      dishes: [
        { id: 'd1', name: '小笼包' },
        { id: 'd2', name: '红烧肉' },
      ],
    });
    expect(info).not.toHaveProperty('rating');
    // The review is the contributor's own file: rating, date, and every photo with its dish.
    expect(await t.readJson(path.join(draft, 'reviews/u-002.json'))).toEqual({
      date: '2026-10-14',
      rating: 4,
      images: ['images/01-photo.jpg'],
      dishes: [
        {
          dish: 'd1',
          verdict: 1,
          comment: '皮薄汁多',
          images: ['images/02-dish-1.jpg', 'images/03-dish-1.jpg', 'images/04-dish-1.jpg'],
        },
        { dish: 'd2', verdict: -1, images: ['images/05-dish-2.jpg', 'images/06-dish-2.jpg'] },
      ],
    });
    const images = await readdir(path.join(draft, 'images'));
    expect(images.sort()).toEqual([
      '01-photo.jpg',
      '02-dish-1.jpg',
      '03-dish-1.jpg',
      '04-dish-1.jpg',
      '05-dish-2.jpg',
      '06-dish-2.jpg',
    ]);
    for (const image of images) {
      expect(await findSensitiveMetadata(path.join(draft, 'images', image))).toEqual([]);
    }
    expect(await readFile(path.join(draft, 'reviews/u-002.md'), 'utf8')).toBe(
      '汤底很浓，环境安静。\n适合两个人慢慢吃。\n',
    );

    // Keywords: registry words and aliases map deterministically; others wait for a decision.
    expect(info.tags).toEqual(['date', 'group']);
    expect(report.keywords.map((k) => [k.keyword, k.via])).toEqual([
      ['适合情侣约会', 'registry'],
      ['约会圣地', 'pending'],
      ['很安静', 'pending'],
      ['适合带宠物', 'pending'],
      ['适合聚餐', 'registry'],
    ]);

    // Restaurant information from the selected OSM listing, with provenance; nothing invented.
    expect(info.altNames).toEqual(['Example Dumpling House']);
    expect(info.cuisines).toEqual(['chinese']);
    expect(info.links).toEqual({ website: 'https://dumplings.example/' });
    expect(info.pricePerPerson).toBeUndefined();
    expect(report.facts.every((f) => f.fact.source && f.fact.evidence)).toBe(true);
    expect(report.notes.join('\n')).toMatch(/map cuisine "shanghainese" has no cuisine key/);

    // The contributor is registered privately; nothing public changed.
    const contributors = await t.readJson(t.options.contributorFiles.privateFile);
    expect(contributors['u-002']).toEqual({ name: '小明', email: 'ming@example.com' });
    expect(JSON.parse(await readFile(t.options.contributorFiles.publicFile, 'utf8'))).toEqual([
      { id: 'u-001', name: '老作者' },
    ]);
    expect(existsSync(t.options.restaurantsDir)).toBe(false);
    expect((await readLog(t.options.submissionsDir)).mAbC12).toMatchObject({
      status: 'drafted',
      restaurantId: id,
    });

    // The review report covers the review checklist and leaks no contact details or tokens.
    const text = await readFile(t.p('private/submissions/tally-mAbC12/review-report.md'), 'utf8');
    for (const part of [
      'mAbC12',
      'new restaurant',
      'Review: a new review',
      'Rating: 4',
      'Dishes: 2',
      '6 stored of 6',
      'pending',
      'OpenStreetMap',
      'Consent: given',
      'content/restaurants/',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('ming@example.com');
    expect(text).not.toContain('accessToken');

    // The draft validates.
    const result = await validate(t);
    expect(
      result.diagnostics.filter(
        (d) => d.restaurantId === id && (d.level === 'error' || d.draftError),
      ),
    ).toEqual([]);
  });

  it('is repeatable: no second restaurant, photo, contributor, or review', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const first = await t.prepare('mAbC12');
    const id = first.restaurantId!;
    const before = await t.listing(t.p('private'));
    const info = await readFile(t.p('private/drafts', id, 'info.json'), 'utf8');
    const requests = t.net.requests.length;

    expect((await t.importCsv(csv(row(NEW_RESTAURANT))))[0]!.outcome).toBe('duplicate');
    const again = await t.prepare('mAbC12');
    expect(again.outcome).toBe('unchanged');
    expect(again.restaurantId).toBe(id);
    expect(await t.listing(t.p('private'))).toEqual(before);
    expect(await readFile(t.p('private/drafts', id, 'info.json'), 'utf8')).toBe(info);
    expect(t.net.requests.length).toBe(requests); // photos and place details are not fetched again
    expect(Object.keys(await t.readJson(t.options.contributorFiles.privateFile))).toEqual([
      'u-002',
    ]);
  });

  it('keeps a draft edited by hand unless asked to rebuild it', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12')).restaurantId!;
    const file = t.p('private/drafts', id, 'reviews/u-002.md');
    await writeFile(file, '编辑过的点评。\n');
    expect((await t.prepare('mAbC12')).outcome).toBe('edited');
    expect(await readFile(file, 'utf8')).toBe('编辑过的点评。\n');
    expect((await t.prepare('mAbC12', { rebuild: true })).outcome).toBe('drafted');
    expect(await readFile(file, 'utf8')).toMatch(/^汤底很浓/);
  });

  it('applies reviewed tag decisions, including a new tag that becomes public on promotion', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    await writeFile(
      t.p('private/submissions/tally-mAbC12/resolutions.json'),
      JSON.stringify({
        tags: [
          { keyword: '约会圣地', tag: 'date' },
          { keyword: '很安静', tag: 'quiet' },
          { keyword: '适合带宠物', newTag: { id: 'pet-friendly', label: '可带宠物' } },
          { keyword: '不是我写的词', tag: 'group' },
        ],
        facts: [
          {
            field: 'pricePerPerson',
            value: 22,
            source: 'official menu',
            evidence: 'https://dumplings.example/menu',
            method: 'inferred',
            confidence: 'medium',
          },
          {
            field: 'altNames',
            value: ['Shady Name'],
            source: 'a blog',
            evidence: 'unsure',
            method: 'inferred',
            confidence: 'low',
          },
        ],
      }),
    );
    const report = await t.prepare('mAbC12');
    const id = report.restaurantId!;
    const info = await t.readJson(t.p('private/drafts', id, 'info.json'));
    expect(info.tags).toEqual(['date', 'quiet', 'pet-friendly', 'group']);
    expect(info.pricePerPerson).toBe(22);
    expect(info.altNames).toEqual(['Example Dumpling House']); // the low-confidence name is only reported
    expect(report.newTags).toEqual(['pet-friendly']);
    expect(report.notes.join('\n')).toMatch(
      /"不是我写的词" is not one of the contributor's keywords/,
    );
    expect(await t.readJson(t.options.tagFiles.privateFile)).toEqual({
      proposed: [{ id: 'pet-friendly', label: '可带宠物' }],
      aliases: { 约会圣地: 'date', 很安静: 'quiet', 适合带宠物: 'pet-friendly' },
    });
    // Drafts may use proposed tags; public restaurants may not.
    expect(
      (await validate(t)).diagnostics.filter((d) => d.restaurantId === id && d.draftError),
    ).toEqual([]);

    // Promotion (what content:promote does after approval) makes the tag public.
    await publishContributors(t.options.contributorFiles, ['u-002']);
    expect(await publishTags(t.options.tagFiles, info.tags as string[])).toEqual(['pet-friendly']);
    await moveDraft(t.options.draftsDir, t.options.restaurantsDir, id);
    const result = await runPipeline({
      restaurantsDir: t.options.restaurantsDir,
      contributorsFile: t.options.contributorFiles.publicFile,
      tagsFile: t.options.tagFiles.publicFile,
      source: 'content',
      includeDrafts: true,
      base: '/',
      cacheDir: t.options.imageCacheDir,
    });
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    expect(result.index.restaurants[0]!.tags).toContainEqual({
      id: 'pet-friendly',
      label: '可带宠物',
    });
    expect((await t.readJson(t.options.tagFiles.privateFile)).proposed).toEqual([]);
  });

  it("adds a second contributor's review to a public restaurant, keeping the first one", async () => {
    const t = await setup();
    await writeRestaurant(
      t.options.restaurantsDir,
      'r-abc234',
      {
        id: 'r-abc234',
        status: 'published',
        name: '示例汤包馆',
        location: { lat: 29.7174, lng: -95.4018 },
        tags: ['group'],
        dishes: [{ id: 'd1', name: '小笼包', altNames: ['Xiaolongbao'] }],
      },
      {
        'reviews/u-001.json': JSON.stringify({
          date: '2026-09-01',
          rating: 5,
          dishes: [{ dish: 'd1', verdict: -1 }],
        }),
        'reviews/u-001.md': '第一位作者的点评。\n',
      },
    );
    const publicBefore = await t.listing(t.options.restaurantsDir);
    await t.importCsv(
      csv(
        row({
          ...NEW_RESTAURANT,
          'Submission ID': 'second',
          restaurant_id: 'r-abc234',
          selection_method: 'existing',
          source: 'restaurant-page',
        }),
      ),
    );
    const report = await t.prepare('second');
    expect(report.outcome).toBe('drafted');
    expect(report.mode).toBe('existing');
    expect(report.updatesReview).toBe(false);
    // The public restaurant is untouched until the draft is promoted.
    expect(await t.listing(t.options.restaurantsDir)).toEqual(publicBefore);
    const draft = t.p('private/drafts/r-abc234');
    expect(await readFile(path.join(draft, 'reviews/u-001.md'), 'utf8')).toBe(
      '第一位作者的点评。\n',
    );
    // The same dish is the same dish; a new name is a new dish.
    const info = await t.readJson(path.join(draft, 'info.json'));
    expect(info.dishes).toEqual([
      { id: 'd1', name: '小笼包', altNames: ['Xiaolongbao'] },
      { id: 'd2', name: '红烧肉' },
    ]);
    expect(report.dishes.map((d) => [d.name, d.dish, d.newDish])).toEqual([
      ['小笼包', 'd1', false],
      ['红烧肉', 'd2', true],
    ]);
    const review = await t.readJson(path.join(draft, 'reviews/u-002.json'));
    expect(review).toMatchObject({ date: '2026-10-14', rating: 4 });
    expect((review.dishes as { dish: string }[]).map((d) => d.dish)).toEqual(['d1', 'd2']);
    expect((await readLog(t.options.submissionsDir)).second).toMatchObject({
      status: 'drafted',
      restaurantId: 'r-abc234',
    });
    const result = await validate(t);
    expect(
      result.diagnostics.filter(
        (d) => d.restaurantId === 'r-abc234' && (d.level === 'error' || d.draftError),
      ),
    ).toEqual([]);
  });

  it("updates a contributor's earlier review instead of adding a second one", async () => {
    const t = await setup();
    await writeRestaurant(
      t.options.restaurantsDir,
      'r-abc234',
      {
        id: 'r-abc234',
        status: 'published',
        name: '示例汤包馆',
        location: { lat: 29.7174, lng: -95.4018 },
        dishes: [{ id: 'd1', name: '锅贴' }],
      },
      {
        'reviews/u-001.json': JSON.stringify({ date: '2026-09-01', rating: 5 }),
        'reviews/u-002.json': JSON.stringify({
          date: '2026-08-01',
          rating: 2,
          dishes: [{ dish: 'd1', verdict: 1, comment: '好吃' }],
        }),
        'reviews/u-002.md': '旧的点评。\n',
      },
    );
    await mkdir(path.dirname(t.options.contributorFiles.privateFile), { recursive: true });
    await writeFile(
      t.options.contributorFiles.privateFile,
      JSON.stringify({ 'u-002': { name: '小明', email: 'ming@example.com' } }),
    );
    await t.importCsv(
      csv(
        row({
          ...NEW_RESTAURANT,
          'Submission ID': 'again',
          restaurant_id: 'r-abc234',
          selection_method: 'existing',
          source: 'restaurant-page',
        }),
      ),
    );
    const report = await t.prepare('again');
    expect(report.outcome).toBe('drafted');
    expect(report.updatesReview).toBe(true);
    const draft = t.p('private/drafts/r-abc234');
    expect((await readdir(path.join(draft, 'reviews'))).sort()).toEqual([
      'u-001.json',
      'u-002.json',
      'u-002.md',
    ]);
    const review = await t.readJson(path.join(draft, 'reviews/u-002.json'));
    // The new rating, date and text; the dish it does not mention again stays.
    expect(review).toMatchObject({ date: '2026-10-14', rating: 4 });
    expect((review.dishes as { dish: string }[]).map((d) => d.dish)).toEqual(['d2', 'd3', 'd1']);
    expect(await readFile(path.join(draft, 'reviews/u-002.md'), 'utf8')).toMatch(/^汤底很浓/);

    // Rejecting it puts the earlier review back.
    const rejected = await t.reject('again');
    expect(rejected.status).toBe('done');
    expect(rejected.messages.join('\n')).toMatch(/earlier review is back/);
    expect(await readFile(path.join(draft, 'reviews/u-002.md'), 'utf8')).toBe('旧的点评。\n');
    expect(await t.readJson(path.join(draft, 'reviews/u-002.json'))).toMatchObject({ rating: 2 });
  });

  it('keeps a later review in the draft when the submission that created it is rejected', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12')).restaurantId!;
    // A second, anonymous submission about the new draft adds its own review...
    await t.importCsv(
      csv(
        row({
          ...NEW_RESTAURANT,
          'Submission ID': 'later',
          '署名（选填）': '',
          '联系邮箱（选填）': '',
          总体评级: '🤤 人上人',
        }),
      ),
    );
    const later = await t.prepare('later', { restaurantId: id });
    expect(later.outcome).toBe('drafted');
    expect(later.contributor?.id).toBe('u-003');
    const draft = t.p('private/drafts', id);
    expect((await readdir(path.join(draft, 'reviews'))).sort()).toEqual([
      'u-002.json',
      'u-002.md',
      'u-003.json',
      'u-003.md',
    ]);
    // ...and the first one is rejected: only its review and photos go.
    const rejected = await t.reject('mAbC12');
    expect(rejected.status).toBe('done');
    expect((await readdir(path.join(draft, 'reviews'))).sort()).toEqual(['u-003.json', 'u-003.md']);
    const review = await t.readJson(path.join(draft, 'reviews/u-003.json'));
    const images = await readdir(path.join(draft, 'images'));
    expect(images.map((i) => `images/${i}`).sort()).toEqual(
      [
        ...((review.images as string[] | undefined) ?? []),
        ...(review.dishes as { images?: string[] }[]).flatMap((d) => d.images ?? []),
      ].sort(),
    );
    // The dishes it rates stay; what only the rejected submission gave can be filled again.
    expect((await t.readJson(path.join(draft, 'info.json'))).dishes).toHaveLength(2);
    expect((await t.prepare('later', { restaurantId: id })).outcome).toBe('drafted');
    expect(await t.readJson(path.join(draft, 'info.json'))).toMatchObject({
      address: '6100 Main St, Houston',
      location: { lat: 29.7174, lng: -95.4018 },
    });
    expect((await t.readJson(t.options.contributorFiles.privateFile))['u-003']).toEqual({
      name: '匿名',
    });
  });

  it('produces a valid draft without website, price, or cuisine, and survives a failed lookup', async () => {
    const t = await setup();
    t.net.down.add('/api/interpreter');
    await t.importCsv(
      csv(
        row({
          'Submission ID': 'bare',
          总体评级: '🤤 人上人',
          发布授权: CONSENT,
          restaurant_name: '路边摊',
          restaurant_lat: '29.72',
          restaurant_lng: '-95.40',
          selection_method: 'manual',
          source: 'site',
        }),
      ),
    );
    const report = await t.prepare('bare');
    expect(report.outcome).toBe('drafted');
    expect(report.poi?.status).toBe('failed');
    const info = await t.readJson(t.p('private/drafts', report.restaurantId!, 'info.json'));
    expect(Object.keys(info)).toEqual(['id', 'status', 'name', 'location']);
    expect(
      await t.readJson(t.p('private/drafts', report.restaurantId!, 'reviews/u-002.json')),
    ).toEqual({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      rating: 3,
    });
    expect(report.missing).toEqual(['address', 'cuisines', 'pricePerPerson', 'website']);
    expect(report.contributor?.name).toBe('匿名');
  });

  it('waits for missing photos, then keeps every photo with its dish after recovery', async () => {
    const t = await setup();
    t.net.down.add('/private/xlb-b.jpg');
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const blocked = await t.prepare('mAbC12');
    expect(blocked.outcome).toBe('blocked');
    expect(blocked.blockers.join('\n')).toMatch(/photo 3 not retrieved/);
    expect(existsSync(t.options.draftsDir)).toBe(false);
    t.net.down.clear();
    const { retryPhotos } = await import('../../scripts/content/submissions.ts');
    await retryPhotos('mAbC12', {
      submissionsDir: t.options.submissionsDir,
      restaurantsDir: t.options.restaurantsDir,
      fetchImpl: t.net.fetchImpl,
      lookup: t.net.lookup,
    });
    const report = await t.prepare('mAbC12');
    expect(report.outcome).toBe('drafted');
    expect(report.dishes.map((d) => d.images.length)).toEqual([3, 2]);
  });

  it('separates anonymous and named credits even with the same email', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    await t.prepare('mAbC12');
    await t.importCsv(
      csv(
        row({
          ...NEW_RESTAURANT,
          'Submission ID': 'anon',
          '署名（选填）': '',
          restaurant_name: '另一家',
          poi_id: '',
          poi_provider: '',
          restaurant_lat: '29.70',
          restaurant_lng: '-95.38',
        }),
        row({
          ...NEW_RESTAURANT,
          'Submission ID': 'named',
          restaurant_name: '第三家',
          poi_id: '',
          poi_provider: '',
          restaurant_lat: '29.69',
          restaurant_lng: '-95.37',
        }),
      ),
    );
    const anon = await t.prepare('anon', { offline: true });
    expect(anon.contributor).toMatchObject({ id: 'u-003', created: true, name: '匿名' });
    expect(anon.notes.join('\n')).toMatch(/kept as a separate contributor/);
    const named = await t.prepare('named', { offline: true });
    expect(named.contributor).toMatchObject({ id: 'u-002', created: false });
  });

  it('flags contact details in the text that would become public', async () => {
    const t = await setup();
    await t.importCsv(
      csv(
        row({
          ...NEW_RESTAURANT,
          '你的点评（选填）': '老板微信：dumpling88，电话 713-555-0199，邮箱 boss@example.com',
        }),
      ),
    );
    const report = await t.prepare('mAbC12', { offline: true });
    expect(report.privacy.join('\n')).toMatch(/email address/);
    expect(report.privacy.join('\n')).toMatch(/phone number/);
    expect(report.privacy.join('\n')).toMatch(/contact handle/);
  });

  it('needs the maintainer when the restaurant match is uncertain', async () => {
    const t = await setup();
    await writeRestaurant(t.options.restaurantsDir, 'r-near01', {
      id: 'r-near01',
      status: 'published',
      name: '示例汤包馆',
      location: { lat: 29.7175, lng: -95.4019 },
    });
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const report = await t.prepare('mAbC12');
    expect(report.outcome).toBe('blocked');
    expect(report.blockers.join('\n')).toMatch(/--id <restaurant id>/);
    expect(existsSync(t.options.draftsDir)).toBe(false);
    // With the maintainer's decision it is the existing restaurant: the review is added to it.
    const decided = await t.prepare('mAbC12', { restaurantId: 'r-near01' });
    expect(decided.outcome).toBe('drafted');
    expect(decided.mode).toBe('existing');
    expect(existsSync(t.p('private/drafts/r-near01/reviews/u-001.json'))).toBe(true);
    expect(existsSync(t.p('private/drafts/r-near01/reviews/u-002.json'))).toBe(true);
    // The id of that restaurant with another name, right there, is not used without a decision.
    await t.importCsv(
      csv(
        row({
          ...NEW_RESTAURANT,
          'Submission ID': 'byid',
          restaurant_id: 'r-near01',
          restaurant_name: '隔壁面馆',
        }),
      ),
    );
    const conflict = await t.prepare('byid');
    expect(conflict.identity).toMatch(/^CONFLICT: id r-near01/);
    expect(conflict.outcome).toBe('blocked');
    expect((await t.prepare('byid', { asNew: true })).outcome).toBe('drafted');
  });

  it('never prepares a submission without consent', async () => {
    const t = await setup();
    await t.importCsv(csv(row({ ...NEW_RESTAURANT, 发布授权: '' })));
    const report = await t.prepare('mAbC12');
    expect(report.outcome).toBe('blocked');
    expect(report.blockers.join('\n')).toMatch(/no publication consent/);
    expect(existsSync(t.options.draftsDir)).toBe(false);
  });

  it('works without network access, and a submission without keywords', async () => {
    const t = await setup();
    const { '标签（选填）': _unused, ...withoutKeywords } = NEW_RESTAURANT;
    void _unused;
    await t.importCsv(csv(row(withoutKeywords)));
    const requests = t.net.requests.length;
    const report = await t.prepare('mAbC12', { offline: true });
    expect(report.outcome).toBe('drafted');
    expect(report.poi?.status).toBe('skipped');
    expect(t.net.requests.length).toBe(requests);
    const info = await t.readJson(t.p('private/drafts', report.restaurantId!, 'info.json'));
    expect(info.tags).toBeUndefined();
  });

  it('restores photos removed from an untouched draft', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12', { offline: true })).restaurantId!;
    await rm(t.p('private/drafts', id), { recursive: true });
    const report = await t.prepare('mAbC12', { offline: true });
    expect(report.outcome).toBe('drafted');
    expect(await readdir(t.p('private/drafts', id, 'images'))).toHaveLength(6);
  });
});

describe('map listing identity', () => {
  const listing = (extra: Record<string, unknown>, tags: Record<string, unknown>) => ({
    type: 'node',
    id: 1001,
    lat: 29.7174,
    lon: -95.4018,
    ...extra,
    tags: { amenity: 'restaurant', cuisine: 'chinese', website: 'https://other.example/', ...tags },
  });
  const enriched = async (t: Awaited<ReturnType<typeof setup>>, id: string) => {
    const info = await t.readJson(t.p('private/drafts', id, 'info.json'));
    return { cuisines: info.cuisines, links: info.links, altNames: info.altNames };
  };

  it('never uses another branch of a chain, even with the same name', async () => {
    const t = await setup();
    t.net.places.splice(0, 1, listing({ lat: 29.76, lon: -95.36 }, { name: '示例汤包馆' }));
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const report = await t.prepare('mAbC12');
    expect(report.outcome).toBe('drafted'); // the draft is still made
    expect(report.listing?.verdict).toBe('rejected');
    expect(report.listing?.reasons.join('; ')).toMatch(/another branch/);
    expect(await enriched(t, report.restaurantId!)).toEqual({
      cuisines: undefined,
      links: undefined,
      altNames: undefined,
    });
    expect(report.facts.every((f) => !f.applied)).toBe(true);
    expect(report.conflicts.join('\n')).toMatch(/map listing REJECTED/);
    const text = await readFile(t.p('private/submissions/tally-mAbC12/review-report.md'), 'utf8');
    expect(text).toMatch(/Map listing identity: \*\*rejected\*\*/);
  });

  it('never uses a POI id that belongs to another restaurant nearby', async () => {
    const t = await setup();
    t.net.places.splice(0, 1, listing({ lat: 29.7183 }, { name: 'Other Noodle Bar' }));
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const report = await t.prepare('mAbC12');
    expect(report.listing?.verdict).toBe('rejected');
    expect((await enriched(t, report.restaurantId!)).links).toBeUndefined();
  });

  it('accepts a name in another language at the same spot and address', async () => {
    const t = await setup();
    t.net.places.splice(
      0,
      1,
      listing(
        {},
        {
          name: 'Example Dumpling House',
          'addr:housenumber': '6100',
          'addr:street': 'Main Street',
          'addr:city': 'Houston',
        },
      ),
    );
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const report = await t.prepare('mAbC12');
    expect(report.listing?.verdict).toBe('verified');
    expect(await enriched(t, report.restaurantId!)).toEqual({
      cuisines: ['chinese'],
      links: { website: 'https://other.example/' },
      altNames: undefined,
    });
  });

  it('leaves an unconfirmed listing to the maintainer, whose decision is recorded', async () => {
    const t = await setup();
    t.net.places.splice(0, 1, listing({}, { name: 'Example Dumpling House' }));
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const first = await t.prepare('mAbC12');
    expect(first.listing?.verdict).toBe('ambiguous');
    expect(first.conflicts.join('\n')).toMatch(/"key": "osm:node\/1001", "decision": "same-place"/);
    expect((await enriched(t, first.restaurantId!)).cuisines).toBeUndefined();

    await writeFile(
      t.p('private/submissions/tally-mAbC12/resolutions.json'),
      JSON.stringify({
        listing: {
          key: 'osm:node/1001',
          decision: 'same-place',
          reason: 'English name on the storefront photo',
        },
      }),
    );
    const second = await t.prepare('mAbC12');
    expect(second.listing).toMatchObject({ verdict: 'verified', decidedBy: 'maintainer' });
    expect((await enriched(t, first.restaurantId!)).cuisines).toEqual(['chinese']);
    const text = await readFile(t.p('private/submissions/tally-mAbC12/review-report.md'), 'utf8');
    expect(text).toContain(
      'maintainer decision (resolutions.json): English name on the storefront photo',
    );

    // A decision about another listing is not used.
    await writeFile(
      t.p('private/submissions/tally-mAbC12/resolutions.json'),
      JSON.stringify({ listing: { key: 'osm:node/9', decision: 'same-place', reason: 'x' } }),
    );
    const third = await t.prepare('mAbC12', { rebuild: true });
    expect(third.listing?.verdict).toBe('ambiguous');
    expect(third.notes.join('\n')).toMatch(/about another listing/);
  });

  it('does not use a listing without coordinates on its name alone', async () => {
    const t = await setup();
    t.net.places.splice(0, 1, {
      type: 'node',
      id: 1001,
      tags: { name: '示例汤包馆', cuisine: 'chinese' },
    });
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const report = await t.prepare('mAbC12');
    expect(report.outcome).toBe('drafted');
    expect(report.listing?.verdict).toBe('ambiguous');
    expect(report.listing?.reasons.join('; ')).toMatch(/no coordinates/);
  });
});

describe('rejecting a prepared submission', () => {
  const rawFiles = async (t: Awaited<ReturnType<typeof setup>>, id: string) =>
    (await readdir(t.p('private/submissions', `tally-${id}`)))
      .filter((f) => f === 'submission.json' || f.startsWith('photo-'))
      .sort();

  it('removes a draft it created, keeps the raw submission, and withdraws its proposed tag', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    await writeFile(
      t.p('private/submissions/tally-mAbC12/resolutions.json'),
      JSON.stringify({
        tags: [{ keyword: '适合带宠物', newTag: { id: 'pet-friendly', label: '可带宠物' } }],
      }),
    );
    const id = (await t.prepare('mAbC12')).restaurantId!;
    const raw = await rawFiles(t, 'mAbC12');
    expect(raw).toHaveLength(7);
    const result = await t.reject('mAbC12');
    expect(result.status).toBe('done');
    expect(existsSync(t.p('private/drafts', id))).toBe(false);
    expect(await rawFiles(t, 'mAbC12')).toEqual(raw);
    expect(await t.readJson(t.options.tagFiles.privateFile)).toEqual({ proposed: [], aliases: {} });
    // The contributor stays registered privately (audit), but nothing credits them.
    expect(Object.keys(await t.readJson(t.options.contributorFiles.privateFile))).toEqual([
      'u-002',
    ]);
    expect(await rejectionProblems(t.options.submissionsDir, id)).toEqual([]);
    expect((await t.prepare('mAbC12')).outcome).toBe('blocked');
  });

  it('takes its content out of an existing manual draft and keeps everything else', async () => {
    const t = await setup();
    const { createDraft, importImages } = await import('../../scripts/content/intake.ts');
    const dir = await createDraft(t.options.draftsDir, 'r-manual1', '示例汤包馆');
    const manual = {
      id: 'r-manual1',
      status: 'draft',
      name: '示例汤包馆',
      address: '6100 Main St, Houston',
      location: { lat: 29.7174, lng: -95.4018 },
      cuisines: ['chinese'],
      tags: ['quiet'],
    };
    await writeFile(path.join(dir, 'info.json'), JSON.stringify(manual, null, 2));
    await makeImage(t.p('manual.jpg'));
    await importImages(dir, [t.p('manual.jpg')]);
    await t.importCsv(
      csv(
        row({
          ...NEW_RESTAURANT,
          '餐厅别名（选填）': '小汤包，示例汤包馆、Example Dumpling House',
        }),
      ),
    );
    const report = await t.prepare('mAbC12', { restaurantId: 'r-manual1' });
    expect(report.outcome).toBe('drafted');
    const prepared = await t.readJson(path.join(dir, 'info.json'));
    // The contributor's other names are added (not the name itself), and taken out again below.
    expect(prepared.altNames).toEqual(['小汤包', 'Example Dumpling House']);
    expect(report.filled.join('\n')).toMatch(
      /altNames \(\+小汤包, Example Dumpling House, from the submission\)/,
    );
    expect(prepared.tags).toEqual(['quiet', 'date', 'group']);
    expect(existsSync(path.join(dir, 'reviews/u-002.json'))).toBe(true);
    expect(prepared.links).toEqual({ website: 'https://dumplings.example/' });
    expect(await readdir(path.join(dir, 'images'))).toHaveLength(7);

    expect((await t.reject('mAbC12')).status).toBe('done');
    expect(await t.readJson(path.join(dir, 'info.json'))).toEqual(manual);
    expect(existsSync(path.join(dir, 'reviews'))).toBe(false);
    expect(await readdir(path.join(dir, 'images'))).toEqual(['01-manual.jpg']);
    expect(await rawFiles(t, 'mAbC12')).toHaveLength(7);

    // Another submission about it starts from the manual draft again.
    await t.importCsv(
      csv(
        row({ ...NEW_RESTAURANT, 'Submission ID': 'second', '联系邮箱（选填）': 'b@example.com' }),
      ),
    );
    const second = await t.prepare('second', { restaurantId: 'r-manual1' });
    expect(second.outcome).toBe('drafted');
    expect(second.updatesReview).toBe(false);
    expect(await readdir(path.join(dir, 'reviews'))).toEqual(['u-003.json', 'u-003.md']);
  });

  it('keeps edits the maintainer made to other fields', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12', { offline: true })).restaurantId!;
    const file = t.p('private/drafts', id, 'info.json');
    await writeFile(
      file,
      JSON.stringify({ ...(await t.readJson(file)), pricePerPerson: 20 }, null, 2),
    );
    expect((await t.reject('mAbC12')).status).toBe('done');
    expect(await t.readJson(file)).toEqual({
      id,
      status: 'draft',
      name: '示例汤包馆',
      pricePerPerson: 20,
    });
    expect(existsSync(t.p('private/drafts', id, 'reviews/u-002.json'))).toBe(false);
    expect(await readdir(t.p('private/drafts', id, 'images'))).toEqual([]);
  });

  it('changes nothing and blocks promotion when the maintainer edited what it wrote', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12', { offline: true })).restaurantId!;
    const draft = t.p('private/drafts', id);
    await editAddress(t, draft, '6100 Main Street, Houston, TX');
    const before = await t.listing(draft);
    const info = await readFile(path.join(draft, 'info.json'), 'utf8');

    const result = await t.reject('mAbC12');
    expect(result.status).toBe('manual');
    expect(result.messages.join('\n')).toMatch(/info\.json "address"/);
    expect(await t.listing(draft)).toEqual(before);
    expect(await readFile(path.join(draft, 'info.json'), 'utf8')).toBe(info);
    expect((await rejectionProblems(t.options.submissionsDir, id)).join('\n')).toMatch(
      /rejected, but its content is still in the draft: edited by hand/,
    );
    expect(
      (await validate(t)).diagnostics.filter((d) => d.restaurantId === id && d.draftError),
    ).toEqual([]);

    // The maintainer keeps their own address: confirmed explicitly, everything else is taken out.
    const resolved = await t.reject('mAbC12', true);
    expect(resolved.status).toBe('resolved');
    expect(await t.readJson(path.join(draft, 'info.json'))).toEqual({
      id,
      status: 'draft',
      name: '示例汤包馆',
      address: '6100 Main Street, Houston, TX',
    });
    expect(existsSync(path.join(draft, 'reviews/u-002.json'))).toBe(false);
    expect(await rejectionProblems(t.options.submissionsDir, id)).toEqual([]);
  });

  it('blocks promotion of a submission marked rejected but not rolled back', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12', { offline: true })).restaurantId!;
    await markSubmission(t.options.submissionsDir, 'mAbC12', 'rejected');
    expect((await rejectionProblems(t.options.submissionsDir, id)).join('\n')).toMatch(
      /marked rejected, but its content is still in the draft/,
    );
    expect((await rejectSubmission('mAbC12', t.options)).status).toBe('done');
    expect(await rejectionProblems(t.options.submissionsDir, id)).toEqual([]);
  });
});

describe('rebuilding a draft', () => {
  const images = async (t: Awaited<ReturnType<typeof setup>>, id: string) =>
    (await readdir(t.p('private/drafts', id, 'images'))).sort();
  const hashes = async (t: Awaited<ReturnType<typeof setup>>, id: string) => {
    const { createHash } = await import('node:crypto');
    const out: Record<string, string> = {};
    for (const name of await images(t, id)) {
      out[name] = createHash('sha256')
        .update(await readFile(t.p('private/drafts', id, 'images', name)))
        .digest('hex');
    }
    return out;
  };

  it('is idempotent for an unchanged submission', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12', { offline: true })).restaurantId!;
    const before = await hashes(t, id);
    for (let i = 0; i < 2; i++) {
      const report = await t.prepare('mAbC12', { offline: true, rebuild: true });
      expect(report.outcome).toBe('unchanged');
      expect(report.removedImages).toEqual([]);
      expect(await hashes(t, id)).toEqual(before);
    }
  });

  it('replaces a replaced photo in place and removes a waived one', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12', { offline: true })).restaurantId!;
    const before = await hashes(t, id);
    const sub = t.p('private/submissions/tally-mAbC12');
    const { addManualPhoto, waivePhoto } = await import('../../scripts/content/submissions.ts');
    const stored = JSON.parse(
      await readFile(path.join(sub, 'submission.json'), 'utf8'),
    ) as Submission;
    // Photo 3 (dish 1) is replaced by another picture; photo 5 (dish 2) is lost and waived.
    await rm(path.join(sub, 'photo-03.jpg'));
    await rm(path.join(sub, 'photo-05.jpg'));
    await makeImage(t.p('replacement.jpg'), { width: 90, height: 60 });
    await addManualPhoto(sub, stored, 3, t.p('replacement.jpg'));
    await waivePhoto(sub, stored, 5);

    const report = await t.prepare('mAbC12', { offline: true, rebuild: true });
    expect(report.outcome).toBe('drafted');
    expect(report.removedImages.sort()).toEqual(['images/03-dish-1.jpg', 'images/05-dish-2.jpg']);
    expect(await images(t, id)).toEqual([
      '01-photo.jpg',
      '02-dish-1.jpg',
      '03-dish-1.jpg',
      '04-dish-1.jpg',
      '06-dish-2.jpg',
    ]);
    const after = await hashes(t, id);
    expect(after['03-dish-1.jpg']).not.toBe(before['03-dish-1.jpg']);
    expect(after['01-photo.jpg']).toBe(before['01-photo.jpg']); // the cover stays
    const review = await t.readJson(t.p('private/drafts', id, 'reviews/u-002.json'));
    expect((review.dishes as { images?: string[] }[]).map((d) => d.images)).toEqual([
      ['images/02-dish-1.jpg', 'images/03-dish-1.jpg', 'images/04-dish-1.jpg'],
      ['images/06-dish-2.jpg'],
    ]);
    expect(
      (await validate(t)).diagnostics.filter(
        (d) => d.restaurantId === id && (d.level === 'error' || d.draftError),
      ),
    ).toEqual([]);
    // Repeating it changes nothing.
    expect((await t.prepare('mAbC12', { offline: true, rebuild: true })).outcome).toBe('unchanged');
  });

  it('keeps images added by hand and reports them', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12', { offline: true })).restaurantId!;
    const { importImages } = await import('../../scripts/content/intake.ts');
    await makeImage(t.p('extra.jpg'));
    await importImages(t.p('private/drafts', id), [t.p('extra.jpg')]);
    const report = await t.prepare('mAbC12', { offline: true, rebuild: true });
    expect(report.otherImages).toEqual(['images/07-extra.jpg']);
    expect(await images(t, id)).toContain('07-extra.jpg');
    const text = await readFile(t.p('private/submissions/tally-mAbC12/review-report.md'), 'utf8');
    expect(text).toMatch(/Kept images not from this submission.*07-extra\.jpg/);
  });
});

describe('new tag privacy', () => {
  it('never proposes a tag label with contact details, and flags questionable ones', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    await writeFile(
      t.p('private/submissions/tally-mAbC12/resolutions.json'),
      JSON.stringify({
        tags: [
          { keyword: '约会圣地', newTag: { id: 'wechat', label: 'vx dumpling88' } },
          { keyword: '很安静', newTag: { id: 'call-us', label: '713 555 0199' } },
          { keyword: '适合带宠物', newTag: { id: 'pay', label: '微信支付' } },
        ],
      }),
    );
    const report = await t.prepare('mAbC12', { offline: true });
    const notes = report.notes.join('\n');
    expect(notes).toMatch(/new tag not used: tag "wechat" label "vx dumpling88": a contact handle/);
    expect(notes).toMatch(/new tag not used: tag "call-us" label "713 555 0199": phone number/);
    expect(notes).toMatch(
      /review the new tag: tag "pay" label "微信支付": a contact or social-media word/,
    );
    const info = await t.readJson(t.p('private/drafts', report.restaurantId!, 'info.json'));
    expect(info.tags).toEqual(['date', 'pay', 'group']);
    expect((await t.readJson(t.options.tagFiles.privateFile)).proposed).toEqual([
      { id: 'pay', label: '微信支付' },
    ]);
  });
});

describe('rejection rollback state', () => {
  type T = Awaited<ReturnType<typeof setup>>;
  const statePath = (t: T) => t.p('private/submissions/tally-mAbC12/prepare.json');
  /** A drafted submission whose address the maintainer edited, then rejected: the rollback needs them. */
  async function conflicted() {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12', { offline: true })).restaurantId!;
    const draft = t.p('private/drafts', id);
    await editAddress(t, draft, '6100 Main Street, Houston, TX');
    expect((await t.reject('mAbC12')).status).toBe('manual');
    return { t, id, draft };
  }

  it('keeps blocking promotion whatever status the submission is marked with afterwards', async () => {
    const { t, id, draft } = await conflicted();
    const before = await t.listing(draft);
    for (const status of ['drafted', 'imported', 'processed'] as const) {
      await expect(t.mark('mAbC12', status)).rejects.toThrow(
        /rejection of mAbC12 is waiting for the maintainer; nothing was changed/,
      );
      expect((await readLog(t.options.submissionsDir)).mAbC12!.status).toBe('rejected');
    }
    await expect(t.mark('mAbC12', 'drafted', true)).rejects.toThrow(
      /--resolved only confirms a rejection/,
    );
    // Even a log changed behind the CLI's back does not lift the block: it follows prepare.json.
    await markSubmission(t.options.submissionsDir, 'mAbC12', 'drafted');
    expect((await rejectionProblems(t.options.submissionsDir, id)).join('\n')).toMatch(
      /mAbC12 was rejected, but its content is still in the draft: edited by hand .*address/,
    );
    // Nor can prepare overwrite it.
    const again = await t.prepare('mAbC12', { offline: true, rebuild: true });
    expect(again.outcome).toBe('blocked');
    expect(again.blockers.join('\n')).toMatch(/rejection is waiting for the maintainer/);
    expect(await t.listing(draft)).toEqual(before);
    expect(JSON.parse(await readFile(statePath(t), 'utf8')).rejection.status).toBe('manual');
  });

  it('fails content:check, full or for that draft, until the rollback is resolved', async () => {
    const { t, id } = await conflicted();
    const { createDraft } = await import('../../scripts/content/intake.ts');
    await createDraft(t.options.draftsDir, 'r-other1', '无关的店');
    // The real CLI, run on this temporary database (it uses the repository layout).
    const repo = process.cwd();
    for (const dir of ['scripts', 'shared'])
      await cp(path.join(repo, dir), t.p(dir), { recursive: true });
    for (const file of ['site.config.ts', 'package.json'])
      await cp(path.join(repo, file), t.p(file));
    await symlink(path.join(repo, 'node_modules'), t.p('node_modules'));
    await mkdir(t.p('content/restaurants'), { recursive: true });
    await cp(t.p('contributors.json'), t.p('content/contributors.json'));
    await cp(t.p('tags.json'), t.p('content/tags.json'));
    const check = (...ids: string[]) =>
      spawnSync(
        path.join(repo, 'node_modules/.bin/tsx'),
        ['scripts/content/cli.ts', 'check', ...ids],
        {
          cwd: t.root,
          encoding: 'utf8',
        },
      );
    const full = check();
    expect(full.status).toBe(1);
    expect(full.stderr).toMatch(
      new RegExp(`error   private/drafts/${id}: submission mAbC12 was rejected`),
    );
    expect(full.stdout).toMatch(/Check failed/);
    expect(check(id).status).toBe(1);
    expect(check('r-other1').status).toBe(0);
    await t.reject('mAbC12', true);
    const after = check();
    expect(after.stdout).toMatch(/Check passed/);
    expect(after.status).toBe(0);
  }, 30_000);

  it('lifts the block after the maintainer resolves the conflict, keeping unrelated edits', async () => {
    const { t, id, draft } = await conflicted();
    const info = path.join(draft, 'info.json');
    await writeFile(
      info,
      JSON.stringify({ ...(await t.readJson(info)), pricePerPerson: 25 }, null, 2),
    );
    // The maintainer puts the submission's address back as it was written, so it can be taken out.
    await editAddress(t, draft, '6100 Main St, Houston');
    expect((await t.reject('mAbC12')).status).toBe('done');
    expect(await rejectionProblems(t.options.submissionsDir, id)).toEqual([]);
    expect(await t.readJson(info)).toEqual({
      id,
      status: 'draft',
      name: '示例汤包馆',
      pricePerPerson: 25,
    });
    expect(existsSync(path.join(draft, 'reviews'))).toBe(false);
    // Afterwards the status may change again; the finished rollback blocks nothing.
    await t.mark('mAbC12', 'processed');
    expect(await rejectionProblems(t.options.submissionsDir, id)).toEqual([]);
  });

  it('recovers an interrupted rollback, and an unreadable state blocks with a clear message', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const id = (await t.prepare('mAbC12', { offline: true })).restaurantId!;
    // As if the process stopped right after recording the start of the rollback.
    const state = JSON.parse(await readFile(statePath(t), 'utf8'));
    await writeFile(
      statePath(t),
      JSON.stringify({ ...state, rejection: { status: 'pending', at: 'now', details: [] } }),
    );
    expect((await rejectionProblems(t.options.submissionsDir, id)).join('\n')).toMatch(
      /rejection did not finish/,
    );
    await expect(t.mark('mAbC12', 'drafted')).rejects.toThrow(/is unfinished/);
    expect((await t.prepare('mAbC12', { offline: true })).outcome).toBe('blocked');
    expect((await t.reject('mAbC12')).status).toBe('done');
    expect(existsSync(t.p('private/drafts', id))).toBe(false);
    expect(await rejectionProblems(t.options.submissionsDir, id)).toEqual([]);

    await writeFile(statePath(t), '{ broken');
    expect((await rejectionProblems(t.options.submissionsDir, id)).join('\n')).toMatch(
      /tally-mAbC12\/prepare.json cannot be read .*restore the file from the private backup/,
    );
    await expect(t.mark('mAbC12', 'drafted')).rejects.toThrow(/prepare.json cannot be read/);
  });

  it('is idempotent once finished', async () => {
    const t = await setup();
    const { createDraft } = await import('../../scripts/content/intake.ts');
    const dir = await createDraft(t.options.draftsDir, 'r-manual1', '示例汤包馆');
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    await writeFile(
      t.p('private/submissions/tally-mAbC12/resolutions.json'),
      JSON.stringify({
        tags: [{ keyword: '适合带宠物', newTag: { id: 'pet-friendly', label: '可带宠物' } }],
      }),
    );
    await t.prepare('mAbC12', { restaurantId: 'r-manual1', offline: true });
    expect((await t.reject('mAbC12')).status).toBe('done');
    const snapshot = async () => ({
      draft: await t.listing(dir),
      info: await readFile(path.join(dir, 'info.json'), 'utf8'),
      tags: await readFile(t.options.tagFiles.privateFile, 'utf8'),
      contributors: await readFile(t.options.contributorFiles.privateFile, 'utf8'),
      state: await readFile(statePath(t), 'utf8'),
      raw: (await readdir(t.p('private/submissions/tally-mAbC12'))).filter((f) =>
        f.startsWith('photo-'),
      ),
    });
    const after = await snapshot();
    for (let i = 0; i < 2; i++) {
      expect((await t.reject('mAbC12')).status).toBe('nothing');
      expect(await snapshot()).toEqual(after);
    }
    expect(after.raw).toHaveLength(6);
    expect(await rejectionProblems(t.options.submissionsDir, 'r-manual1')).toEqual([]);
  });
});

describe('lost prepare state', () => {
  type T = Awaited<ReturnType<typeof setup>>;
  const sub = (t: T, id = 'mAbC12') => t.p('private/submissions', `tally-${id}`);
  /** Submission mAbC12 drafted into a new restaurant, and an unrelated one drafted elsewhere. */
  async function prepared() {
    const t = await setup();
    await t.importCsv(
      csv(
        row(NEW_RESTAURANT),
        row({
          ...NEW_RESTAURANT,
          'Submission ID': 'other',
          '联系邮箱（选填）': 'o@example.com',
          restaurant_name: '另一家',
          poi_id: '',
          poi_provider: '',
          restaurant_lat: '29.70',
          restaurant_lng: '-95.38',
        }),
      ),
    );
    const id = (await t.prepare('mAbC12', { offline: true })).restaurantId!;
    const other = (await t.prepare('other', { offline: true })).restaurantId!;
    const draft = t.p('private/drafts', id);
    return { t, id, other, draft, before: await t.listing(draft) };
  }

  it('rejects a submission that was never prepared normally', async () => {
    const t = await setup();
    await t.importCsv(csv(row(NEW_RESTAURANT)));
    const result = await t.reject('mAbC12');
    expect(result.status).toBe('nothing');
    expect((await readLog(t.options.submissionsDir)).mAbC12).toMatchObject({ status: 'rejected' });
    expect(existsSync(path.join(sub(t), 'submission.json'))).toBe(true);
    expect(existsSync(path.join(sub(t), 'prepare.json'))).toBe(false);
  });

  it('refuses to reject when prepare.json is gone after it wrote a draft, and blocks only that draft', async () => {
    const { t, id, other, draft, before } = await prepared();
    expect((await readLog(t.options.submissionsDir)).mAbC12!.draftWritten).toBe(true);
    await rm(path.join(sub(t), 'prepare.json'));
    await expect(t.reject('mAbC12')).rejects.toThrow(
      /prepare.json is missing, but the log shows this submission wrote into the draft .*Restore the file from the private backup.*--state-lost.*nothing was changed/,
    );
    expect((await readLog(t.options.submissionsDir)).mAbC12!.status).toBe('drafted');
    expect(await t.listing(draft)).toEqual(before);
    expect(existsSync(path.join(sub(t), 'submission.json'))).toBe(true);
    // --resolved is not a way around it, and neither is another status.
    await expect(t.reject('mAbC12', true)).rejects.toThrow(/prepare.json is missing/);
    await expect(t.mark('mAbC12', 'processed')).rejects.toThrow(/prepare.json is missing/);
    // rejectSubmission itself never reports success without state.
    expect((await rejectSubmission('mAbC12', t.options)).status).toBe('manual');
    // Promotion of that draft is refused; the unrelated draft is not affected.
    expect((await rejectionProblems(t.options.submissionsDir, id)).join('\n')).toMatch(
      /prepare.json is missing, but the log shows this submission wrote into the draft/,
    );
    expect(await rejectionProblems(t.options.submissionsDir, other)).toEqual([]);
    // Nor can prepare start over as if nothing happened.
    const again = await t.prepare('mAbC12', { offline: true });
    expect(again.outcome).toBe('blocked');
    expect(again.blockers.join('\n')).toMatch(/prepare.json is missing/);
    expect(await t.listing(draft)).toEqual(before);
  });

  it('keeps blocking when the status was changed behind its back, the file is corrupt, or the folder is gone', async () => {
    const { t, id, other } = await prepared();
    const problems = () => rejectionProblems(t.options.submissionsDir, id);
    // Missing file, whatever the log says.
    await rm(path.join(sub(t), 'prepare.json'));
    for (const status of ['rejected', 'processed', 'imported'] as const) {
      await markSubmission(t.options.submissionsDir, 'mAbC12', status);
      expect((await problems()).join('\n')).toMatch(/prepare.json is missing/);
    }
    // Corrupt file.
    await writeFile(path.join(sub(t), 'prepare.json'), '{ broken');
    expect((await problems()).join('\n')).toMatch(/prepare.json cannot be read/);
    // The whole folder gone (the log still links the submission to the draft).
    await rm(sub(t), { recursive: true });
    expect((await problems()).join('\n')).toMatch(
      /the folder private\/submissions\/tally-mAbC12\/ is missing; .*prepare.json is missing/,
    );
    expect(await rejectionProblems(t.options.submissionsDir, other)).toEqual([]);
  });

  it('recovers from the backup: the rejection then runs normally', async () => {
    const { t, id } = await prepared();
    const backup = await readFile(path.join(sub(t), 'prepare.json'), 'utf8');
    await rm(path.join(sub(t), 'prepare.json'));
    await expect(t.reject('mAbC12')).rejects.toThrow(/prepare.json is missing/);
    await writeFile(path.join(sub(t), 'prepare.json'), backup);
    expect((await t.reject('mAbC12')).status).toBe('done');
    expect(existsSync(t.p('private/drafts', id))).toBe(false);
    expect(await rejectionProblems(t.options.submissionsDir, id)).toEqual([]);
    expect((await readLog(t.options.submissionsDir)).mAbC12).toMatchObject({
      status: 'rejected',
      draftWritten: false,
    });
    expect((await t.reject('mAbC12')).status).toBe('nothing');
  });

  it('recovers without a backup only through an explicit, recorded check by the maintainer', async () => {
    const { t, id, draft } = await prepared();
    await rm(path.join(sub(t), 'prepare.json'));
    await expect(t.reject('mAbC12', false, '  ')).rejects.toThrow(/--state-lost needs a note/);
    // Only a rejection can be confirmed this way; other statuses change nothing.
    const log = await readFile(t.p('private/submissions/tally-log.json'), 'utf8');
    for (const status of ['processed', 'imported', 'drafted'] as const) {
      await expect(t.mark('mAbC12', status, false, 'checked')).rejects.toThrow(
        /--state-lost only confirms a rejection/,
      );
    }
    expect(await readFile(t.p('private/submissions/tally-log.json'), 'utf8')).toBe(log);
    await expect(t.mark('other', 'rejected', false, 'checked')).rejects.toThrow(
      /--state-lost is only for a submission whose prepare.json is lost/,
    );
    // The maintainer removes the submission's content from the draft by hand, then confirms.
    const info = path.join(draft, 'info.json');
    await writeFile(info, JSON.stringify({ id, status: 'draft', name: '示例汤包馆' }, null, 2));
    await rm(path.join(draft, 'reviews'), { recursive: true });
    await rm(path.join(draft, 'images'), { recursive: true });
    const result = await markOutcome('mAbC12', 'rejected', {
      ...t.options,
      stateLost: 'removed the review, dishes, photos, and credit from the draft',
      now: () => '2026-10-15T10:00:00Z',
    });
    expect(result.status).toBe('nothing');
    const entry = (await readLog(t.options.submissionsDir)).mAbC12!;
    expect(entry).toMatchObject({ status: 'rejected', draftWritten: false });
    expect(entry.audit).toEqual([
      {
        at: '2026-10-15T10:00:00Z',
        action: `prepare.json lost; draft ${id} checked by the maintainer`,
        note: 'removed the review, dishes, photos, and credit from the draft',
      },
    ]);
    expect(await rejectionProblems(t.options.submissionsDir, id)).toEqual([]);
    // The tool itself changed nothing in the draft, and the raw submission stays.
    expect(await t.readJson(info)).toEqual({ id, status: 'draft', name: '示例汤包馆' });
    expect(existsSync(path.join(sub(t), 'submission.json'))).toBe(true);
  });
});
