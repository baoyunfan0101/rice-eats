import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  exifHasGps,
  findSensitiveMetadata,
  sniffImageFormat,
} from '../../scripts/content/privacy.ts';
import { checkTrackedFiles } from '../../scripts/check-privacy.ts';
import { importImages } from '../../scripts/content/intake.ts';
import { makeImage, makePhonePhoto, tempDir, writeRestaurant, validInfo } from './helpers.ts';

describe('image privacy', () => {
  it('detects GPS, other EXIF, and XMP metadata by content', async () => {
    const dir = await tempDir();
    await makePhonePhoto(path.join(dir, 'gps.jpg'));
    await sharp({ create: { width: 50, height: 50, channels: 3, background: 'red' } })
      .withExif({ IFD0: { Copyright: 'someone' } })
      .png()
      .toFile(path.join(dir, 'exif.png'));
    await sharp({ create: { width: 50, height: 50, channels: 3, background: 'red' } })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>')
      .webp()
      .toFile(path.join(dir, 'xmp.webp'));
    await makeImage(path.join(dir, 'clean.jpg'));
    // A JPEG with a misleading extension is still recognized.
    await makePhonePhoto(path.join(dir, 'disguised.txt'));

    expect(await findSensitiveMetadata(path.join(dir, 'gps.jpg'))).toEqual([
      'EXIF metadata with GPS location',
    ]);
    expect(await findSensitiveMetadata(path.join(dir, 'exif.png'))).toEqual(['EXIF metadata']);
    expect(await findSensitiveMetadata(path.join(dir, 'xmp.webp'))).toEqual(['XMP metadata']);
    expect(await findSensitiveMetadata(path.join(dir, 'clean.jpg'))).toEqual([]);
    expect(await sniffImageFormat(path.join(dir, 'disguised.txt'))).toBe('jpeg');
    const exif = (await sharp(path.join(dir, 'gps.jpg')).metadata()).exif!;
    expect(exifHasGps(exif)).toBe(true);
  });

  it('blocks tracked photos with metadata and tracked private files', async () => {
    const root = await tempDir();
    await makePhonePhoto(path.join(root, 'content/restaurants/a/images/gps.jpg'));
    await makePhonePhoto(path.join(root, 'public/photo.dat'));
    await makeImage(path.join(root, 'fixtures/clean.jpg'));
    await writeFile(path.join(root, 'notes.txt'), 'text');
    const problems = await checkTrackedFiles(root, [
      'content/restaurants/a/images/gps.jpg',
      'public/photo.dat',
      'fixtures/clean.jpg',
      'notes.txt',
      'drafts/secret/info.json',
      'submissions/x/IMG_1.JPG',
    ]);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(
      /gps.jpg: contains EXIF metadata with GPS location; import the photo/,
    );
    expect(problems[1]).toMatch(/public\/photo.dat: contains EXIF metadata with GPS location/);
    expect(problems[2]).toMatch(
      /drafts\/secret\/info.json: private drafts and submissions must not be committed/,
    );
    expect(problems[3]).toMatch(/submissions\/x\/IMG_1.JPG/);
  });

  it('import writes a clean copy that passes the check and leaves the original alone', async () => {
    const root = await tempDir();
    const original = path.join(root, 'IMG_0001.JPG');
    await makePhonePhoto(original);
    const dir = await writeRestaurant(root, 'r', validInfo('r'));
    const [copy] = await importImages(dir, [original]);
    expect(await findSensitiveMetadata(copy!.stored)).toEqual([]);
    expect(await findSensitiveMetadata(original)).toEqual(['EXIF metadata with GPS location']);
    expect(await checkTrackedFiles(root, [path.relative(root, copy!.stored)])).toEqual([]);
  });
});

describe('repository', () => {
  it('has no tracked private files or images with metadata', async () => {
    const { execFileSync } = await import('node:child_process');
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    expect(await checkTrackedFiles(process.cwd(), files)).toEqual([]);
  });
});
