import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  createDraft,
  extractDocument,
  importImages,
  moveDraft,
  safeStem,
  setStatus,
} from '../../scripts/content/intake.ts';
import { findSensitiveMetadata } from '../../scripts/content/privacy.ts';
import { missingInfo } from '../../scripts/content/report.ts';
import { makePhonePhoto, pipeline, tempDir } from './helpers.ts';

const SAMPLE = path.resolve('fixtures/submissions/sample-submission');
const sha = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

describe('intake helpers', () => {
  it('creates a draft and refuses to overwrite an existing folder', async () => {
    const drafts = await tempDir();
    const dir = await createDraft(drafts, 'new-place', '新店');
    expect(JSON.parse(await readFile(path.join(dir, 'info.json'), 'utf8'))).toEqual({
      id: 'new-place',
      status: 'draft',
      name: '新店',
    });
    await expect(createDraft(drafts, 'new-place', 'Again')).rejects.toThrow(/already exists/);
    await expect(createDraft(drafts, 'Bad Id', 'x')).rejects.toThrow(/invalid id/);
  });

  it('keeps drafts and submissions out of Git by default', () => {
    const ignored = (file: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', file]);
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('drafts/any-restaurant/info.json')).toBe(true);
    expect(ignored('drafts/any-restaurant/images/photo.jpg')).toBe(true);
    expect(ignored('submissions/any/IMG_0001.HEIC')).toBe(true);
    expect(ignored('content/restaurants/any/info.json')).toBe(false);
    expect(ignored('fixtures/submissions/sample-submission/notes.txt')).toBe(false);
  });

  it('makes safe file names', () => {
    expect(safeStem('IMG 2041 (1).HEIC')).toBe('img-2041-1');
    expect(safeStem('可颂.jpg')).toBe('photo');
  });

  it('imports photos upright and metadata-free without touching originals or overwriting', async () => {
    const dir = await createDraft(await tempDir(), 'sample', 'Sample');
    const original = path.join(await tempDir(), 'IMG_0001.JPG');
    await makePhonePhoto(original);
    const before = await sha(original);

    const [first] = await importImages(dir, [original]);
    expect(path.basename(first!.stored)).toBe('img-0001.jpg');
    expect(await sha(original)).toBe(before);
    expect(await findSensitiveMetadata(first!.stored)).toEqual([]);
    const meta = await sharp(first!.stored).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 2400]); // rotated upright, capped at 2400

    const [second] = await importImages(dir, [original]);
    expect(path.basename(second!.stored)).toBe('img-0001-2.jpg');

    const [png] = await importImages(dir, [path.join(SAMPLE, 'Dish Photo 2.png')]);
    expect(path.basename(png!.stored)).toBe('dish-photo-2.jpg');
  });

  it.runIf(process.platform === 'darwin')('converts HEIC photos at intake', async () => {
    const dir = await createDraft(await tempDir(), 'heic', 'HEIC');
    const [image] = await importImages(dir, [path.join(SAMPLE, 'IMG_0003.HEIC')]);
    expect(path.basename(image!.stored)).toBe('img-0003.jpg');
    expect((await sharp(image!.stored).metadata()).format).toBe('jpeg');
    expect(await findSensitiveMetadata(image!.stored)).toEqual([]);
  });

  it('extracts text and embedded images from documents', async () => {
    const notes = await extractDocument(path.join(SAMPLE, 'notes.txt'));
    expect(notes).toContain('晨光面包坊');
    const out = await tempDir();
    const docx = await extractDocument(path.join(SAMPLE, 'review.docx'), out);
    expect(docx).toContain('下次还想试试他们的酸种面包');
    expect(await readdir(out)).toEqual(['review-image-1.png']);
    await expect(extractDocument(path.join(out, 'x.pdf'))).rejects.toThrow(
      /unsupported document format ".pdf"/,
    );
  });

  it('moves an approved draft into public content without replacing anything', async () => {
    const drafts = await tempDir();
    const content = await tempDir();
    await createDraft(drafts, 'a', 'A');
    const moved = await moveDraft(drafts, content, 'a');
    expect(existsSync(path.join(moved, 'info.json'))).toBe(true);
    expect(existsSync(path.join(drafts, 'a'))).toBe(false);
    await createDraft(drafts, 'a', 'A again');
    await expect(moveDraft(drafts, content, 'a')).rejects.toThrow(/already exists/);
  });
});

describe('agent content workflow (synthetic submission)', () => {
  // Mirrors .claude/skills/restaurant-intake/SKILL.md. The text an agent would
  // write is fixed here; everything else uses the real tools.
  it('turns text and photos into a private, validated draft that is promoted and published only on request', async () => {
    const content = await tempDir();
    const drafts = await tempDir();
    const submission = path.join(await tempDir(), 'submission');
    await cp(SAMPLE, submission, { recursive: true });
    await makePhonePhoto(path.join(submission, 'IMG_0001.JPG'));
    const originals = ['IMG_0001.JPG', 'Dish Photo 2.png', 'notes.txt'];
    const before = await Promise.all(originals.map((f) => sha(path.join(submission, f))));

    // Prepare the draft privately.
    const dir = await createDraft(drafts, 'morning-light-bakery', '晨光面包坊（虚构）');
    const images = await importImages(dir, [
      path.join(submission, 'IMG_0001.JPG'),
      path.join(submission, 'Dish Photo 2.png'),
    ]);
    const [croissant, shelf] = images.map((i) => path.relative(dir, i.stored));
    const info = {
      id: 'morning-light-bakery',
      status: 'draft',
      name: '晨光面包坊（虚构）',
      cuisines: ['烘焙'],
      neighborhood: 'Rice Village',
      rating: 3, // the contributor wrote "人上人"
      pricePerPerson: 15,
      cover: croissant,
      dishes: [
        { name: '可颂', verdict: '推荐', comment: '很酥，强烈推荐！', image: croissant },
        { name: '抹茶卷', verdict: '不推荐', comment: '一般，有点甜。' },
      ],
    };
    await writeFile(path.join(dir, 'info.json'), JSON.stringify(info));
    await writeFile(
      path.join(dir, 'review.md'),
      `店面很小，周末早上要排队。咖啡普通，但面包很好。\n\n![店里的面包柜](${shelf})\n`,
    );

    // Validate and preview the private draft.
    const check = await pipeline(content, {
      draftsDir: drafts,
      includeDrafts: true,
      outDir: undefined,
    });
    expect(check.diagnostics.filter((d) => d.level === 'error' || d.draftError)).toEqual([]);
    const restaurant = check.restaurants[0]!;
    expect(restaurant.visibility).toBe('private');
    expect(missingInfo(restaurant)).toEqual([
      'address',
      'location (not shown on the map)',
      'summary',
      'contributors (required to publish)',
    ]);
    expect(check.details[0]!.reviewHtml).toContain('<figure><img');

    // A production build does not even read the drafts directory.
    expect((await pipeline(content)).index.restaurants).toEqual([]);

    // After approval: promote into public content (still unpublished), then publish.
    await writeFile(
      path.join(dir, 'info.json'),
      JSON.stringify({ ...info, contributors: [{ name: '投稿人（虚构）' }] }),
    );
    const publicDir = await moveDraft(drafts, content, 'morning-light-bakery');
    expect((await pipeline(content)).index.restaurants).toEqual([]);
    for (const file of await readdir(path.join(publicDir, 'images'))) {
      expect(await findSensitiveMetadata(path.join(publicDir, 'images', file))).toEqual([]);
    }
    await setStatus(publicDir, 'published');
    const published = await pipeline(content);
    expect(published.failed).toBe(false);
    expect(published.index.restaurants.map((r) => r.id)).toEqual(['morning-light-bakery']);

    // The contributor's original files are untouched.
    expect(await Promise.all(originals.map((f) => sha(path.join(submission, f))))).toEqual(before);
  });
});
