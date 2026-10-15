// Embedded-metadata checks for images that are (or will be) publicly tracked.
// Detection inspects file contents with sharp, not file names.

import { open } from 'node:fs/promises';
import sharp from 'sharp';

/** Image formats recognized by their leading bytes. */
export async function sniffImageFormat(file: string): Promise<string | undefined> {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0);
    const b = buffer.subarray(0, bytesRead);
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    if (b.toString('latin1', 4, 8) === 'ftyp') return 'heif'; // HEIC, HEIF, AVIF
    if (b.toString('latin1', 0, 4) === 'II*\0' || b.toString('latin1', 0, 4) === 'MM\0*') return 'tiff';
    if (b.toString('latin1', 0, 3) === 'GIF') return 'gif';
    return undefined;
  } finally {
    await handle.close();
  }
}

/** True when an EXIF block contains a GPS sub-directory (tag 0x8825 in IFD0). */
export function exifHasGps(exif: Buffer): boolean {
  let tiff = exif;
  if (tiff.toString('latin1', 0, 6) === 'Exif\0\0') tiff = tiff.subarray(6);
  if (tiff.length < 8) return false;
  const little = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return false;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 2 > tiff.length) break;
    if (u16(entry) === 0x8825) return true;
  }
  return false;
}

/**
 * Lists embedded metadata that must not appear in public images.
 * ICC colour profiles are allowed; EXIF (camera, time, GPS), XMP, and IPTC are not.
 */
export async function findSensitiveMetadata(file: string): Promise<string[]> {
  const meta = await sharp(file).metadata();
  const problems: string[] = [];
  if (meta.exif) {
    problems.push(exifHasGps(meta.exif) ? 'EXIF metadata with GPS location' : 'EXIF metadata');
  }
  if (meta.xmp) problems.push('XMP metadata');
  if (meta.iptc) problems.push('IPTC metadata');
  return problems;
}

export const PRIVACY_FIX =
  'import the photo with "npm run content:add-images", which writes a clean copy';

/**
 * Obvious contact details and private links in text that is about to become
 * public (review.md, dish comments, names): email addresses, phone numbers,
 * Tally file links (which carry access tokens), and social-media handles.
 * A heuristic for the reviewer, not a guarantee; each finding names its kind
 * and a short excerpt.
 */
export function findContactDetails(text: string): string[] {
  const found: string[] = [];
  const add = (kind: string, match: string) => found.push(`${kind} "${match.slice(0, 40)}"`);
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) add('email address', m[0]);
  for (const m of text.matchAll(/https?:\/\/[^\s)]*tally\.so\/[^\s)]*/gi)) add('Tally link', m[0].split('?')[0]!);
  // Phone numbers: +1 / US formats and 11-digit mainland China mobile numbers.
  for (const m of text.matchAll(/(?<![\w.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)|(?<!\d)1[3-9]\d{9}(?!\d)/g)) {
    add('phone number', m[0]);
  }
  for (const m of text.matchAll(/(?:微信|wechat|vx|weixin|qq|whatsapp|telegram|instagram|ig)\s*(?:号)?\s*[:：]\s*[\w.-]{3,}/gi)) {
    add('contact handle', m[0]);
  }
  return found;
}
