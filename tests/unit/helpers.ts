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

export const validInfo = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: 'published',
  name: `Test ${id}`,
  cuisines: ['Test'],
  location: { lat: 29.72, lng: -95.4 },
  contributors: [{ name: 'Tester' }],
  ...extra,
});

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

export async function pipeline(restaurantsDir: string, overrides: Partial<PipelineOptions> = {}) {
  const work = await tempDir();
  return runPipeline({
    restaurantsDir,
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
