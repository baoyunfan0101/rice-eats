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
  safeStem,
  setStatus,
} from '../../scripts/content/intake.ts';
import { missingInfo } from '../../scripts/content/report.ts';
import { pipeline, tempDir } from './helpers.ts';

const SAMPLE = path.resolve('fixtures/submissions/sample-submission');
const sha = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

describe('intake helpers', () => {
  it('creates a draft and refuses to overwrite an existing folder', async () => {
    const root = await tempDir();
    const dir = await createDraft(root, 'new-place', '新店');
    expect(JSON.parse(await readFile(path.join(dir, 'info.json'), 'utf8'))).toEqual({
      id: 'new-place',
      status: 'draft',
      name: '新店',
    });
    await expect(createDraft(root, 'new-place', 'Again')).rejects.toThrow(/already exists/);
    await expect(createDraft(root, 'Bad Id', 'x')).rejects.toThrow(/invalid id/);
  });

  it('makes safe file names', () => {
    expect(safeStem('IMG 2041 (1).HEIC')).toBe('img-2041-1');
    expect(safeStem('可颂.jpg')).toBe('photo');
  });

  it('imports photos upright and metadata-free without touching originals or overwriting', async () => {
    const root = await tempDir();
    const dir = await createDraft(root, 'sample', 'Sample');
    const original = path.join(SAMPLE, 'IMG_0001.JPG');
    const before = await sha(original);

    const [first] = await importImages(dir, [original]);
    expect(path.basename(first!.stored)).toBe('img-0001.jpg');
    expect(await sha(original)).toBe(before);
    const meta = await sharp(first!.stored).metadata();
    expect(meta.exif).toBeUndefined();
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
});

describe('agent content workflow (synthetic submission)', () => {
  // Mirrors the steps in .claude/skills/restaurant-intake/SKILL.md. The text an agent
  // would write is fixed here; everything else uses the real tools.
  it('turns text and photos into a validated, unpublished draft', async () => {
    const root = await tempDir();
    const submission = path.join(await tempDir(), 'submission');
    await cp(SAMPLE, submission, { recursive: true });

    const dir = await createDraft(root, 'morning-light-bakery', '晨光面包坊（虚构）');
    const images = await importImages(dir, [
      path.join(submission, 'IMG_0001.JPG'),
      path.join(submission, 'Dish Photo 2.png'),
    ]);
    const [croissant, shelf] = images.map((i) => path.relative(dir, i.stored));
    await writeFile(
      path.join(dir, 'info.json'),
      JSON.stringify({
        id: 'morning-light-bakery',
        status: 'draft',
        name: '晨光面包坊（虚构）',
        cuisines: ['烘焙'],
        neighborhood: 'Rice Village',
        tier: '人上人',
        pricePerPerson: 15,
        cover: croissant,
        dishes: [
          { name: '可颂', verdict: '推荐', comment: '很酥，强烈推荐！', image: croissant },
          { name: '抹茶卷', verdict: '不推荐', comment: '一般，有点甜。' },
        ],
      }),
    );
    await writeFile(
      path.join(dir, 'review.md'),
      `店面很小，周末早上要排队。咖啡普通，但面包很好。\n\n![店里的面包柜](${shelf})\n`,
    );

    const check = await pipeline(root, { includeDrafts: true, outDir: undefined });
    expect(check.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    const restaurant = check.restaurants[0]!;
    expect(missingInfo(restaurant)).toEqual([
      'address',
      'location (not shown on the map)',
      'summary',
      'contributors (required to publish)',
    ]);
    expect(check.details[0]!.reviewHtml).toContain('<figure><img');

    // Still a draft: a production build leaves it out.
    const build = await pipeline(root);
    expect(build.index.restaurants).toEqual([]);

    // Publishing without attribution is refused by validation.
    await setStatus(dir, 'published');
    expect((await pipeline(root)).failed).toBe(true);

    // The contributor's original files are untouched.
    for (const name of ['IMG_0001.JPG', 'Dish Photo 2.png', 'notes.txt']) {
      expect(await sha(path.join(submission, name))).toBe(await sha(path.join(SAMPLE, name)));
    }
    expect(existsSync(path.join(dir, 'images', 'img-0001.jpg'))).toBe(true);
  });
});
