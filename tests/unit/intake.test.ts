import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  addContributor,
  findContributors,
  loadContributors,
  publishContributors,
} from '../../scripts/content/contributors.ts';
import {
  checkoutRestaurant,
  createDraft,
  extractDocument,
  folderChanges,
  importImages,
  moveDraft,
  newRestaurantId,
  safeStem,
  setStatus,
} from '../../scripts/content/intake.ts';
import { runPipeline } from '../../scripts/content/pipeline.ts';
import { findSensitiveMetadata } from '../../scripts/content/privacy.ts';
import { missingInfo } from '../../scripts/content/report.ts';
import { makeImage, makePhonePhoto, tempDir } from './helpers.ts';

const SAMPLE = path.resolve('fixtures/submissions/sample-submission');
const sha = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

/** A throwaway database: public content/ plus a private/ area, like the repository's layout. */
async function makeDatabase() {
  const root = await tempDir();
  const db = {
    restaurants: path.join(root, 'content/restaurants'),
    contributors: path.join(root, 'content/contributors.json'),
    drafts: path.join(root, 'private/drafts'),
    privateContributors: path.join(root, 'private/contributors.json'),
  };
  const files = { publicFile: db.contributors, privateFile: db.privateContributors };
  const check = (includeDrafts: boolean, withDrafts = includeDrafts) =>
    runPipeline({
      restaurantsDir: db.restaurants,
      contributorsFile: db.contributors,
      draftsDir: withDrafts ? db.drafts : undefined,
      privateContributorsFile: withDrafts ? db.privateContributors : undefined,
      source: 'content',
      includeDrafts,
      base: '/rice-eats/',
      cacheDir: path.join(root, 'cache'),
    });
  return { root, db, files, check };
}

describe('intake helpers', () => {
  it('creates drafts with generated ids that do not depend on the name', async () => {
    const drafts = await tempDir();
    const taken = new Set<string>();
    const a = newRestaurantId(taken);
    taken.add(a);
    const b = newRestaurantId(taken);
    expect(a).toMatch(/^r-[a-z0-9]{6}$/);
    expect(b).not.toBe(a);
    const dir = await createDraft(drafts, a, '新店');
    expect(JSON.parse(await readFile(path.join(dir, 'info.json'), 'utf8'))).toEqual({
      id: a,
      status: 'draft',
      name: '新店',
    });
    expect(existsSync(path.join(dir, 'reviews'))).toBe(false); // no empty review
    await expect(createDraft(drafts, a, 'Again')).rejects.toThrow(/already exists/);
    await expect(createDraft(drafts, 'Bad Id', 'x')).rejects.toThrow(/invalid id/);
    await expect(createDraft(drafts, 'r-noname', ' ')).rejects.toThrow(
      /a restaurant name is required/,
    );
  });

  it('keeps the private area out of Git by default', () => {
    const ignored = (file: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', file]);
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('private/drafts/r-abc123/info.json')).toBe(true);
    expect(ignored('private/submissions/x/IMG_0001.HEIC')).toBe(true);
    expect(ignored('private/contributors.json')).toBe(true);
    expect(ignored('content/restaurants/r-abc123/info.json')).toBe(false);
    expect(ignored('content/contributors.json')).toBe(false);
  });

  it('makes safe file names', () => {
    expect(safeStem('IMG 2041 (1).HEIC')).toBe('img-2041-1');
    expect(safeStem('可颂.jpg')).toBe('photo');
  });

  it('stores photos as numbered, upright, metadata-free copies and never touches originals', async () => {
    const dir = await createDraft(await tempDir(), 'r-sample', 'Sample');
    const original = path.join(await tempDir(), 'IMG_0001.JPG');
    await makePhonePhoto(original);
    const before = await sha(original);

    const [first] = await importImages(dir, [original]);
    expect(path.basename(first!.stored)).toBe('01-img-0001.jpg');
    expect(await sha(original)).toBe(before);
    expect(await findSensitiveMetadata(first!.stored)).toEqual([]);
    const meta = await sharp(first!.stored).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 2400]);

    // Later imports are appended, so the first image (the cover) stays the same.
    const [second, png] = await importImages(dir, [
      original,
      path.join(SAMPLE, 'Dish Photo 2.png'),
    ]);
    expect(path.basename(second!.stored)).toBe('02-img-0001.jpg');
    expect(path.basename(png!.stored)).toBe('03-dish-photo-2.jpg');
    expect((await readdir(path.join(dir, 'images'))).sort()).toEqual([
      '01-img-0001.jpg',
      '02-img-0001.jpg',
      '03-dish-photo-2.jpg',
    ]);
  });

  it.runIf(process.platform === 'darwin')('converts HEIC photos at intake', async () => {
    const dir = await createDraft(await tempDir(), 'r-heic', 'HEIC');
    const [image] = await importImages(dir, [path.join(SAMPLE, 'IMG_0003.HEIC')]);
    expect(path.basename(image!.stored)).toBe('01-img-0003.jpg');
    expect((await sharp(image!.stored).metadata()).format).toBe('jpeg');
  });

  it('extracts text and embedded images from documents', async () => {
    expect(await extractDocument(path.join(SAMPLE, 'notes.txt'))).toContain('晨光面包坊');
    const out = await tempDir();
    const docx = await extractDocument(path.join(SAMPLE, 'review.docx'), out);
    expect(docx).toContain('下次还想试试他们的酸种面包');
    expect(await readdir(out)).toEqual(['review-image-1.png']);
    await expect(extractDocument(path.join(out, 'x.pdf'))).rejects.toThrow(
      /unsupported document format ".pdf"/,
    );
  });
});

describe('contributor database', () => {
  it('adds contributors privately, finds them for reuse, and publishes only the display name', async () => {
    const { files } = await makeDatabase();
    const id = await addContributor(files, { name: '小王', email: 'wang@example.com' });
    expect(id).toBe('u-001');
    expect(await addContributor(files, { name: 'Lee' })).toBe('u-002');
    expect((await loadContributors(files)).publicList).toEqual([]);

    expect(await findContributors(files, '小王')).toEqual([
      { id: 'u-001', name: '小王', public: false, matchedContact: false },
    ]);
    expect(await findContributors(files, 'WANG@example.com')).toMatchObject([
      { id: 'u-001', matchedContact: true },
    ]);

    expect(await publishContributors(files, ['u-001'])).toEqual(['u-001']);
    expect(await publishContributors(files, ['u-001'])).toEqual([]); // no duplicates
    const publicText = await readFile(files.publicFile, 'utf8');
    expect(JSON.parse(publicText)).toEqual([{ id: 'u-001', name: '小王' }]);
    expect(publicText).not.toContain('example.com');
    expect(await addContributor(files, { name: 'Third' })).toBe('u-003');
  });
});

describe('agent content workflow (synthetic submissions)', () => {
  // Mirrors .claude/skills/restaurant-intake/SKILL.md. The text an agent would
  // write is fixed here; everything else uses the real tools.
  it('turns text and photos into a private draft that is promoted and published only on request', async () => {
    const { db, files, check } = await makeDatabase();
    const submission = path.join(await tempDir(), 'submission');
    await cp(SAMPLE, submission, { recursive: true });
    await makePhonePhoto(path.join(submission, 'IMG_0001.JPG'));
    const originals = ['IMG_0001.JPG', 'Dish Photo 2.png', 'notes.txt'];
    const before = await Promise.all(originals.map((f) => sha(path.join(submission, f))));

    // Prepare the draft privately: the restaurant, and the contributor's review.
    const id = newRestaurantId(new Set());
    const contributor = await addContributor(files, {
      name: '投稿人（虚构）',
      email: 'someone@example.com',
    });
    const dir = await createDraft(db.drafts, id, '晨光面包坊（虚构）');
    const [croissant, shelf] = (
      await importImages(dir, [
        path.join(submission, 'IMG_0001.JPG'),
        path.join(submission, 'Dish Photo 2.png'),
      ])
    ).map((i) => path.relative(dir, i.stored));
    const info = {
      id,
      status: 'draft',
      name: '晨光面包坊（虚构）',
      cuisines: ['bakery'],
      dishes: [
        { id: 'd1', name: '可颂' },
        { id: 'd2', name: '抹茶卷' },
      ],
    };
    await writeFile(path.join(dir, 'info.json'), JSON.stringify(info));

    const draft = await check(true);
    expect(draft.diagnostics.filter((d) => d.level === 'error' || d.draftError)).toEqual([]);
    expect(missingInfo(draft.restaurants[0]!)).toEqual([
      'a review in reviews/ (required to publish)',
      'address',
      'location (not shown on the map)',
    ]);
    await mkdir(path.join(dir, 'reviews'));
    await writeFile(
      path.join(dir, 'reviews', `v-${contributor.replace('-', '')}.json`),
      JSON.stringify({
        contributor,
        submittedAt: '2026-10-14T12:00:00Z',
        rating: 3, // the contributor wrote "人上人"
        images: [shelf],
        dishes: [
          { dish: 'd1', verdict: 1, comment: '很酥，强烈推荐！', images: [croissant] },
          { dish: 'd2', verdict: -1, comment: '一般，有点甜。' },
        ],
      }),
    );
    await writeFile(
      path.join(dir, 'reviews', `v-${contributor.replace('-', '')}.md`),
      '店面很小，周末早上要排队。\n',
    );
    const reviewed = await check(true);
    expect(reviewed.diagnostics.filter((d) => d.level === 'error' || d.draftError)).toEqual([]);
    expect(reviewed.details[0]!.cover?.alt).toBe('晨光面包坊（虚构）');
    expect((await check(false, false)).index.restaurants).toEqual([]); // production never reads drafts

    // After the maintainer approves: promote, publish.
    await publishContributors(files, [contributor]);
    const publicDir = await moveDraft(db.drafts, db.restaurants, id);
    expect((await check(false, false)).index.restaurants).toEqual([]); // promoted, not yet published
    await setStatus(publicDir, 'published');
    const published = await check(false, false);
    expect(published.failed).toBe(false);
    expect(published.details[0]!.contributors).toEqual([
      { id: contributor, name: '投稿人（虚构）' },
    ]);
    expect(published.details[0]).toMatchObject({ rating: 3, reviewCount: 1 });
    expect(JSON.stringify(published.details)).not.toContain('someone@example.com');

    expect(await Promise.all(originals.map((f) => sha(path.join(submission, f))))).toEqual(before);
  });

  it('accepts an image-only submission', async () => {
    const { db, files, check } = await makeDatabase();
    const contributor = await addContributor(files, { name: 'Photographer' });
    await publishContributors(files, [contributor]);
    const dir = await createDraft(db.drafts, 'r-photos', 'Photo Spot');
    const photo = path.join(await tempDir(), 'photo.jpg');
    await makeImage(photo);
    const stored = (await importImages(dir, [photo, photo])).map((i) =>
      path.relative(dir, i.stored),
    );
    await mkdir(path.join(dir, 'reviews'));
    await writeFile(
      path.join(dir, 'reviews', `v-${contributor.replace('-', '')}.json`),
      JSON.stringify({
        contributor,
        submittedAt: '2026-10-14T12:00:00Z',
        rating: 3,
        images: stored,
      }),
    );
    await moveDraft(db.drafts, db.restaurants, 'r-photos');
    await setStatus(path.join(db.restaurants, 'r-photos'), 'published');
    const detail = (await check(false, false)).details[0]!;
    expect(detail.images).toHaveLength(2);
    expect(detail.reviews[0]).toMatchObject({ html: '', imageIndexes: [0, 1] });
    expect(detail.dishes).toEqual([]);
  });

  it('adds a review to an existing restaurant in place instead of creating a second restaurant', async () => {
    const { db, files, check } = await makeDatabase();
    const first = await addContributor(files, { name: 'Author' });
    const second = await addContributor(files, { name: 'Second' });
    await publishContributors(files, [first, second]);
    const dir = await createDraft(db.drafts, 'r-update', 'Original Name');
    await mkdir(path.join(dir, 'reviews'));
    await writeFile(
      path.join(dir, 'reviews', `v-${first.replace('-', '')}.json`),
      JSON.stringify({ contributor: first, submittedAt: '2026-10-01T12:00:00Z', rating: 5 }),
    );
    await writeFile(path.join(dir, 'reviews', `v-${first.replace('-', '')}.md`), 'First visit.\n');
    await moveDraft(db.drafts, db.restaurants, 'r-update');
    await setStatus(path.join(db.restaurants, 'r-update'), 'published');

    // A later review of the same restaurant: check it out, add it, promote.
    const draft = await checkoutRestaurant(db.restaurants, db.drafts, 'r-update');
    await expect(checkoutRestaurant(db.restaurants, db.drafts, 'r-update')).rejects.toThrow(
      /already exists/,
    );
    await writeFile(
      path.join(draft, 'reviews', `v-${second.replace('-', '')}.json`),
      JSON.stringify({ contributor: second, submittedAt: '2026-10-05T12:00:00Z', rating: 4 }),
    );
    await writeFile(
      path.join(draft, 'reviews', `v-${second.replace('-', '')}.md`),
      'Second visit: still good.\n',
    );
    const edited = JSON.parse(await readFile(path.join(draft, 'info.json'), 'utf8'));
    await writeFile(path.join(draft, 'info.json'), JSON.stringify({ ...edited, name: 'Renamed' }));

    const changes = await folderChanges(draft, path.join(db.restaurants, 'r-update'));
    expect(changes).toEqual({
      added: [
        `reviews/v-${second.replace('-', '')}.json`,
        `reviews/v-${second.replace('-', '')}.md`,
      ],
      changed: ['info.json'],
      removed: [],
    });
    await moveDraft(db.drafts, db.restaurants, 'r-update');

    const result = await check(false, false);
    expect(result.index.restaurants.map((r) => [r.id, r.name, r.status, r.ratingAverage])).toEqual([
      ['r-update', 'Renamed', 'published', 4.5],
    ]);
    expect(await readdir(db.restaurants)).toEqual(['r-update']);
    expect(result.details[0]!.reviews.map((r) => r.contributor.id)).toEqual([second, first]);
    expect(existsSync(path.join(db.drafts, 'r-update'))).toBe(false);
  });
});
