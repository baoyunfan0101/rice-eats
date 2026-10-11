// Restaurant Schema: the single current format of content/restaurants/<folder>/info.json.
// See docs/content.md for the field reference.

import { z } from 'zod';
import { TIERS, VERDICTS } from '../../src/content/model.ts';

const text = z.string().trim().min(1, 'must not be empty');

/** Lowercase URL-safe identifier, e.g. "huynh-restaurant". */
export const idSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'must be lowercase letters, digits, and single hyphens (e.g. "huynh-restaurant")',
  );

/** Path of a file inside the restaurant folder, e.g. "images/pho.jpg". */
export const assetPathSchema = z
  .string()
  .trim()
  .refine((value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), {
    message: 'must be a relative path inside the restaurant folder (no leading "/" or "..")',
  })
  .refine((value) => !/^[a-z]+:/i.test(value), {
    message: 'must be a local file, not a URL; put the image in the images/ folder',
  });

const httpUrl = z.url({ protocol: /^https?$/, message: 'must be an http(s) URL' });

export const restaurantInfoSchema = z.strictObject({
  id: idSchema,
  status: z.enum(['draft', 'published'], { message: 'must be "draft" or "published"' }),
  name: text,
  altNames: z.array(text).optional(),
  summary: text.max(160, 'should be a short summary (160 characters max)').optional(),
  cuisines: z.array(text).optional(),
  neighborhood: text.optional(),
  address: text.optional(),
  location: z
    .strictObject({ lat: z.number(), lng: z.number() })
    .superRefine(({ lat, lng }, ctx) => {
      const swapHint = Math.abs(lng) <= 90 && Math.abs(lat) <= 180 ? '; lat and lng look swapped' : '';
      if (Math.abs(lat) > 90) {
        ctx.addIssue({ code: 'custom', path: ['lat'], message: `must be between -90 and 90${swapHint}` });
      }
      if (Math.abs(lng) > 180) {
        ctx.addIssue({ code: 'custom', path: ['lng'], message: 'must be between -180 and 180' });
      }
    })
    .optional(),
  tier: z.enum(TIERS, { message: `must be one of ${TIERS.join(', ')}` }).optional(),
  pricePerPerson: z.number().positive().max(1000).optional(),
  tags: z.array(text).optional(),
  cover: assetPathSchema.optional(),
  coverAlt: text.optional(),
  dishes: z
    .array(
      z.strictObject({
        name: text,
        verdict: z.enum(VERDICTS, { message: `must be one of ${VERDICTS.join(', ')}` }).optional(),
        comment: text.optional(),
        image: assetPathSchema.optional(),
        imageAlt: text.optional(),
      }),
    )
    .optional(),
  links: z
    .strictObject({
      googleMaps: httpUrl.optional(),
      website: httpUrl.optional(),
    })
    .optional(),
  contributors: z
    .array(
      z.strictObject({
        name: text,
        url: httpUrl.optional(),
      }),
    )
    .optional(),
});

export type RestaurantInfo = z.infer<typeof restaurantInfoSchema>;

/** Formats zod issues as "field.path: message" lines. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
