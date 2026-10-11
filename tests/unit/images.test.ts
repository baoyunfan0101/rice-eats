import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { processImage, RENDITION_WIDTHS } from '../../scripts/content/images.ts';
import { makeImage, tempDir } from './helpers.ts';

const SAMPLE = path.resolve('fixtures/submissions/sample-submission');
const sha = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

describe('image processing', () => {
  it.each(['jpeg', 'png', 'webp'] as const)('converts %s to WebP renditions', async (format) => {
    const dir = await tempDir();
    const file = path.join(dir, `photo.${format === 'jpeg' ? 'jpg' : format}`);
    await makeImage(file, { width: 1200, height: 900, format });
    const image = await processImage(file, path.join(dir, 'cache'));
    expect(image.renditions.map((r) => r.width)).toEqual([480, 960, 1200]);
    for (const r of image.renditions) {
      const meta = await sharp(path.join(image.cacheEntry, r.fileName)).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width! / meta.height!).toBeCloseTo(4 / 3, 1);
    }
  });

  it('resizes oversized photos and never upscales small ones', async () => {
    const dir = await tempDir();
    await makeImage(path.join(dir, 'big.jpg'), { width: 5000, height: 2500 });
    await makeImage(path.join(dir, 'small.jpg'), { width: 300, height: 200 });
    const big = await processImage(path.join(dir, 'big.jpg'), path.join(dir, 'cache'));
    expect(big.renditions.map((r) => r.width)).toEqual(RENDITION_WIDTHS);
    expect(big).toMatchObject({ width: 1600, height: 800 });
    const small = await processImage(path.join(dir, 'small.jpg'), path.join(dir, 'cache'));
    expect(small.renditions.map((r) => [r.width, r.height])).toEqual([[300, 200]]);
  });

  it('applies EXIF orientation and strips metadata including GPS', async () => {
    const source = path.join(SAMPLE, 'IMG_0001.JPG'); // 3000x2000 stored sideways, orientation 6, GPS
    const before = await sharp(source).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif).toBeDefined();

    const dir = await tempDir();
    const image = await processImage(source, dir);
    expect(image.sourceHasExif).toBe(true);
    expect(image).toMatchObject({ width: 1600, height: 2400 }); // upright portrait
    for (const r of image.renditions) {
      const meta = await sharp(path.join(image.cacheEntry, r.fileName)).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(meta.height).toBeGreaterThan(meta.width!);
    }
  });

  it('does not modify source files and produces identical output on every run', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'photo.png');
    await makeImage(file, { width: 1000, height: 1000, format: 'png' });
    const before = await sha(file);
    const first = await processImage(file, path.join(dir, 'cache-a'));
    const second = await processImage(file, path.join(dir, 'cache-b'));
    expect(await sha(file)).toBe(before);
    expect(first.renditions.map((r) => r.fileName)).toEqual(
      second.renditions.map((r) => r.fileName),
    );
    for (const [i, r] of first.renditions.entries()) {
      expect(await sha(path.join(first.cacheEntry, r.fileName))).toBe(
        await sha(path.join(second.cacheEntry, second.renditions[i]!.fileName)),
      );
    }
  });

  it('gives clear errors for unsupported, HEIC, and corrupt files', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.bmp'), 'x');
    await writeFile(path.join(dir, 'b.jpg'), 'not really a jpeg');
    const cache = path.join(dir, 'cache');
    await expect(processImage(path.join(dir, 'a.bmp'), cache)).rejects.toThrow(
      /unsupported image format ".bmp"/,
    );
    await expect(processImage(path.join(SAMPLE, 'IMG_0003.HEIC'), cache)).rejects.toThrow(
      /must be converted first: run "npm run content:add-images/,
    );
    await expect(processImage(path.join(dir, 'b.jpg'), cache)).rejects.toThrow(/cannot read image/);
  });
});
