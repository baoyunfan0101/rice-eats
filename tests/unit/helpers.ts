import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { runPipeline, type PipelineOptions } from '../../scripts/content/pipeline.ts';

export async function tempDir(prefix = 'rice-eats-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function makeImage(
  file: string,
  { width = 800, height = 600, format = 'jpeg' as 'jpeg' | 'png' | 'webp' } = {},
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 80 } },
  })
    .toFormat(format)
    .toFile(file);
}

/**
 * A synthetic phone photo: 3000x2000 pixels stored sideways (EXIF orientation 6)
 * with camera and GPS metadata. Generated at test time so no photo with
 * location metadata is ever committed.
 */
export async function makePhonePhoto(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 230, g: 160, b: 90 } },
  })
    .jpeg({ quality: 80 })
    .withExif({
      IFD0: { Make: 'ExamplePhone', Model: 'Synthetic' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '0/1 0/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '0/1 0/1 0/1',
      },
    })
    .withMetadata({ orientation: 6 })
    .toFile(file);
}

export const validInfo = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: 'published',
  name: `Test ${id}`,
  cuisines: ['japanese'],
  location: { lat: 29.72, lng: -95.4 },
  contributorIds: ['u-001'],
  ...extra,
});

/** Writes a restaurant folder named after its id (or `folder`) with extra files. */
export async function writeRestaurant(
  root: string,
  folder: string,
  info: Record<string, unknown> | string,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'info.json'),
    typeof info === 'string' ? info : JSON.stringify(info, null, 2),
  );
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), contents);
  }
  return dir;
}

/** The public contributor list used by `pipeline()` unless a test passes its own. */
export const TEST_CONTRIBUTORS = [{ id: 'u-001', name: 'Tester' }];
/** The public tag registry used by `pipeline()` unless a test passes its own. */
export const TEST_TAGS = [
  { id: 'date', label: '适合约会' },
  { id: 'group', label: '适合聚餐' },
];

export async function pipeline(restaurantsDir: string, overrides: Partial<PipelineOptions> = {}) {
  const work = await tempDir();
  const contributorsFile = path.join(work, 'contributors.json');
  await writeFile(contributorsFile, JSON.stringify(TEST_CONTRIBUTORS));
  const tagsFile = path.join(work, 'tags.json');
  await writeFile(tagsFile, JSON.stringify(TEST_TAGS));
  return runPipeline({
    restaurantsDir,
    contributorsFile,
    tagsFile,
    source: 'content',
    includeDrafts: false,
    base: '/rice-eats/',
    cacheDir: path.join(work, 'cache'),
    outDir: path.join(work, 'out'),
    ...overrides,
  });
}

export const errors = (result: { diagnostics: { level: string; message: string }[] }) =>
  result.diagnostics.filter((d) => d.level === 'error').map((d) => d.message);
