// Deterministic helpers used by the content-intake Agent Skill:
// scaffold a draft, import photos safely, extract text from documents, publish.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import sharp from 'sharp';
import {
  INTAKE_ONLY_IMAGE_EXTENSIONS,
  SUPPORTED_IMAGE_EXTENSIONS,
  checkImageExtension,
} from './images.ts';
import { IMAGES_DIR, INFO_FILE, REVIEW_FILE } from './pipeline.ts';
import { idSchema, type RestaurantInfo } from './schema.ts';

const run = promisify(execFile);

/** Longest side of photos stored in the repository; renditions top out at 1600 px. */
export const STORED_MAX_SIZE = 2400;

export class IntakeError extends Error {}

/** Creates a draft folder in the private drafts directory. */
export async function createDraft(draftsDir: string, id: string, name: string) {
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) throw new IntakeError(`invalid id "${id}": ${parsedId.error.issues[0]?.message}`);
  if (!name.trim()) throw new IntakeError('a restaurant name is required (--name "...")');
  const dir = path.join(draftsDir, id);
  if (existsSync(dir)) throw new IntakeError(`${dir} already exists; not overwriting it`);
  await mkdir(path.join(dir, IMAGES_DIR), { recursive: true });
  const info: RestaurantInfo = { id, status: 'draft', name: name.trim() };
  await writeFile(path.join(dir, INFO_FILE), `${JSON.stringify(info, null, 2)}\n`);
  await writeFile(path.join(dir, REVIEW_FILE), '');
  return dir;
}

/** Turns a file name into a safe lowercase ASCII stem ("IMG 2041 (1)" -> "img-2041-1"). */
export function safeStem(fileName: string): string {
  const stem = path
    .basename(fileName, path.extname(fileName))
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stem || 'photo';
}

export interface ImportedImage {
  source: string;
  stored: string;
  width: number;
  height: number;
}

/**
 * Copies contributor photos into <restaurant>/images/. Originals are never
 * modified. Stored copies are upright, at most STORED_MAX_SIZE px, and free of
 * metadata such as GPS location, because the repository is public.
 * Existing files are never overwritten; a numeric suffix is added instead.
 */
export async function importImages(restaurantDir: string, files: string[]): Promise<ImportedImage[]> {
  if (!existsSync(path.join(restaurantDir, INFO_FILE))) {
    throw new IntakeError(`${restaurantDir} has no ${INFO_FILE}; create the draft first`);
  }
  const imagesDir = path.join(restaurantDir, IMAGES_DIR);
  await mkdir(imagesDir, { recursive: true });
  const imported: ImportedImage[] = [];
  for (const file of files) {
    if (!existsSync(file)) throw new IntakeError(`${file} does not exist`);
    const ext = path.extname(file).toLowerCase();
    let input = file;
    let tempDir: string | undefined;
    if (INTAKE_ONLY_IMAGE_EXTENSIONS.includes(ext)) {
      tempDir = await mkdtemp(path.join(os.tmpdir(), 'rice-eats-heic-'));
      input = await convertHeic(file, tempDir);
    } else {
      try {
        checkImageExtension(file);
      } catch (e) {
        throw new IntakeError(`${file}: ${(e as Error).message}`);
      }
    }
    try {
      const bytes = await readFile(input);
      const image = sharp(bytes).rotate();
      // Keep PNG only when transparency matters; photos become JPEG.
      const keepPng = ext === '.png' && !(await sharp(bytes).stats()).isOpaque;
      const outExt = keepPng ? '.png' : '.jpg';
      const target = uniquePath(imagesDir, safeStem(file), outExt);
      const pipeline = image.resize({
        width: STORED_MAX_SIZE,
        height: STORED_MAX_SIZE,
        fit: 'inside',
        withoutEnlargement: true,
      });
      const info = await (keepPng
        ? pipeline.png()
        : pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true })
      ).toFile(target);
      imported.push({ source: file, stored: target, width: info.width, height: info.height });
    } catch (e) {
      if (e instanceof IntakeError) throw e;
      throw new IntakeError(`${file}: cannot read image (${(e as Error).message})`);
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  }
  return imported;
}

function uniquePath(dir: string, stem: string, ext: string): string {
  let candidate = path.join(dir, `${stem}${ext}`);
  for (let n = 2; existsSync(candidate); n++) candidate = path.join(dir, `${stem}-${n}${ext}`);
  return candidate;
}

async function convertHeic(file: string, tempDir: string): Promise<string> {
  // Prebuilt sharp cannot decode HEVC-compressed HEIC, so use platform tools.
  const out = path.join(tempDir, `${safeStem(file)}.jpg`);
  if (process.platform === 'darwin') {
    await run('sips', ['-s', 'format', 'jpeg', file, '--out', out]);
    return out;
  }
  try {
    await run('heif-convert', [file, out]);
    return out;
  } catch {
    throw new IntakeError(
      `${file}: HEIC/HEIF needs macOS (sips) or libheif's heif-convert; ` +
        'otherwise ask the contributor for JPEG copies',
    );
  }
}

export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown'];
export const DOCX_EXTENSIONS = ['.docx'];
/** Converted with macOS textutil, or pandoc when available. */
export const OTHER_DOCUMENT_EXTENSIONS = ['.doc', '.rtf', '.odt', '.html', '.htm'];

/**
 * Extracts text from a contributor document as Markdown-like text. Images
 * embedded in .docx files are saved to `imagesOut` (when given) so they can be
 * imported with importImages.
 */
export async function extractDocument(file: string, imagesOut?: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.includes(ext)) return readFile(file, 'utf8');
  if (DOCX_EXTENSIONS.includes(ext)) {
    let count = 0;
    if (imagesOut) await mkdir(imagesOut, { recursive: true });
    const convert = (mammoth as unknown as { convertToMarkdown: typeof mammoth.convertToHtml })
      .convertToMarkdown;
    const result = await convert(
      { path: file },
      {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async (image) => {
          count += 1;
          const extension = image.contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
          const name = `${safeStem(file)}-image-${count}.${extension}`;
          if (imagesOut) await writeFile(path.join(imagesOut, name), await image.readAsBuffer());
          return { src: imagesOut ? path.join(imagesOut, name) : `(embedded image ${count})` };
        }),
      },
    );
    return result.value;
  }
  if (OTHER_DOCUMENT_EXTENSIONS.includes(ext)) {
    if (process.platform === 'darwin') {
      const { stdout } = await run('textutil', ['-convert', 'txt', '-stdout', file]);
      return stdout;
    }
    try {
      const { stdout } = await run('pandoc', ['-t', 'gfm', file]);
      return stdout;
    } catch {
      throw new IntakeError(`${file}: ${ext} needs macOS textutil or pandoc`);
    }
  }
  throw new IntakeError(
    `${file}: unsupported document format "${ext}". Supported: ` +
      [...TEXT_EXTENSIONS, ...DOCX_EXTENSIONS, ...OTHER_DOCUMENT_EXTENSIONS].join(', ') +
      `; images: ${[...SUPPORTED_IMAGE_EXTENSIONS, ...INTAKE_ONLY_IMAGE_EXTENSIONS].join(', ')}. ` +
      'For PDFs or screenshots, ask the contributor for the text or read it manually.',
  );
}

/**
 * Moves an approved draft from the private drafts directory into the public
 * content directory. Refuses to replace an existing folder.
 */
export async function moveDraft(draftsDir: string, restaurantsDir: string, id: string) {
  const from = path.join(draftsDir, id);
  const to = path.join(restaurantsDir, id);
  if (!existsSync(path.join(from, INFO_FILE))) throw new IntakeError(`no draft at ${from}`);
  if (existsSync(to)) {
    throw new IntakeError(`${to} already exists; merge the changes by hand instead of replacing it`);
  }
  await mkdir(restaurantsDir, { recursive: true });
  await rename(from, to);
  return to;
}

/** Sets "status" in info.json; other fields keep their values. */
export async function setStatus(restaurantDir: string, status: 'draft' | 'published') {
  const infoPath = path.join(restaurantDir, INFO_FILE);
  const original = await readFile(infoPath, 'utf8');
  const info = JSON.parse(original) as Record<string, unknown>;
  info.status = status;
  await writeFile(infoPath, `${JSON.stringify(info, null, 2)}\n`);
  return original;
}

