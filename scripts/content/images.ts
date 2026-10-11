// Deterministic image processing: source photos -> resized, auto-oriented,
// metadata-free WebP renditions. Source files are only ever read.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Metadata } from 'sharp';

/** Extensions the pipeline accepts as image sources. */
export const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

/** Formats contributors commonly send that must be converted at intake first. */
export const INTAKE_ONLY_IMAGE_EXTENSIONS = ['.heic', '.heif'];

/** Rendition widths in pixels. Images are never upscaled past their own width. */
export const RENDITION_WIDTHS = [480, 960, 1600];
const WEBP_OPTIONS = { quality: 78, effort: 4 } as const;

export interface Rendition {
  /** Output name: "<source name>-<content hash>-<width>.webp". */
  fileName: string;
  /** Name of the file inside the cache entry ("<width>.webp"). */
  cacheFile: string;
  width: number;
  height: number;
  bytes: number;
}

export interface ProcessedImage {
  renditions: Rendition[];
  /** Size of the largest rendition. */
  width: number;
  height: number;
  /** Cache directory holding the rendition files. */
  cacheEntry: string;
}

export class ImageError extends Error {}

/**
 * Canonical (stored) images: "<NN>-<name>.jpg|png" in a restaurant's images/
 * folder. The number fixes the order; the first image is the cover. They are
 * written by content:add-images: upright, at most STORED_MAX_SIZE px, no metadata.
 */
export const CANONICAL_IMAGE_NAME = /^\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*\.(jpg|png)$/;
export const STORED_MAX_SIZE = 2400;

/** Problems that make a stored image non-canonical (empty when it is fine). */
export async function canonicalImageProblems(file: string): Promise<string[]> {
  const problems: string[] = [];
  const name = path.basename(file);
  if (!CANONICAL_IMAGE_NAME.test(name)) {
    problems.push('name must look like "03-dish-name.jpg" (number for ordering, lowercase, .jpg or .png)');
  }
  let meta: Metadata;
  try {
    meta = await sharp(file).metadata();
  } catch {
    return [...problems, 'not a readable image'];
  }
  const expected = name.endsWith('.png') ? 'png' : 'jpeg';
  if (meta.format !== expected) problems.push(`content is ${meta.format}, not ${expected}`);
  if ((meta.width ?? 0) > STORED_MAX_SIZE || (meta.height ?? 0) > STORED_MAX_SIZE) {
    problems.push(`larger than ${STORED_MAX_SIZE}px`);
  }
  if (meta.orientation && meta.orientation !== 1) problems.push('not rotated upright');
  return problems;
}

export function checkImageExtension(file: string): void {
  const ext = path.extname(file).toLowerCase();
  if (SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) return;
  if (INTAKE_ONLY_IMAGE_EXTENSIONS.includes(ext)) {
    throw new ImageError(
      `${ext} photos must be converted first: run "npm run content:add-images -- <id> <photo>", ` +
        'which converts HEIC/HEIF to JPEG (macOS sips) and keeps the original untouched',
    );
  }
  throw new ImageError(
    `unsupported image format "${ext || '(none)'}"; supported: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`,
  );
}

/**
 * Processes one source image into WebP renditions stored in `cacheDir`.
 * Results are keyed by the source bytes and settings, so repeated runs reuse
 * earlier output and always produce identical files.
 */
export async function processImage(sourcePath: string, cacheDir: string): Promise<ProcessedImage> {
  checkImageExtension(sourcePath);
  const input = await readFile(sourcePath);
  const key = createHash('sha256')
    .update(input)
    // Everything that affects the cached files is part of the key.
    .update(JSON.stringify({ RENDITION_WIDTHS, WEBP_OPTIONS, sharp: sharp.versions.sharp, files: '<width>.webp' }))
    .digest('hex')
    .slice(0, 16);
  const entryDir = path.join(cacheDir, key);
  const manifestPath = path.join(entryDir, 'manifest.json');

  // The cache is keyed by content only; output names also carry the source name.
  const base = path.basename(sourcePath, path.extname(sourcePath)).toLowerCase();
  const named = (cached: Omit<ProcessedImage, 'cacheEntry'>): ProcessedImage => ({
    ...cached,
    renditions: cached.renditions.map((r) => ({ ...r, fileName: `${base}-${key.slice(0, 8)}-${r.width}.webp` })),
    cacheEntry: entryDir,
  });
  try {
    return named(JSON.parse(await readFile(manifestPath, 'utf8')) as Omit<ProcessedImage, 'cacheEntry'>);
  } catch {
    // Not cached yet.
  }

  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch (error) {
    throw new ImageError(`cannot read image: ${(error as Error).message}`);
  }
  if (!meta.width || !meta.height) throw new ImageError('cannot determine image size');
  // EXIF orientations 5-8 swap width and height once the image is rotated upright.
  const swap = (meta.orientation ?? 1) >= 5;
  const sourceWidth = swap ? meta.height : meta.width;

  const widths = RENDITION_WIDTHS.filter((w) => w < sourceWidth);
  widths.push(Math.min(sourceWidth, RENDITION_WIDTHS.at(-1)!));

  await mkdir(entryDir, { recursive: true });
  const renditions: Rendition[] = [];
  for (const width of [...new Set(widths)]) {
    const { data, info } = await sharp(input)
      .rotate() // apply EXIF orientation; metadata (EXIF, GPS) is dropped on output
      .resize({ width, withoutEnlargement: true })
      .webp(WEBP_OPTIONS)
      .toBuffer({ resolveWithObject: true });
    const cacheFile = `${info.width}.webp`;
    await writeFile(path.join(entryDir, cacheFile), data);
    renditions.push({ fileName: '', cacheFile, width: info.width, height: info.height, bytes: info.size });
  }

  const largest = renditions.at(-1)!;
  const result = {
    renditions,
    width: largest.width,
    height: largest.height,
  };
  // Write the manifest last (atomically) so an interrupted run is never treated as cached.
  await writeFile(`${manifestPath}.tmp`, JSON.stringify(result));
  await rename(`${manifestPath}.tmp`, manifestPath);
  return named(result);
}

/** Copies cached renditions into a public output directory. */
export async function copyRenditions(image: ProcessedImage, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const rendition of image.renditions) {
    await copyFile(path.join(image.cacheEntry, rendition.cacheFile), path.join(outDir, rendition.fileName));
  }
}
