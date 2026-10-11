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
