// The canonical database formats:
//   content/restaurants/<id>/info.json   restaurant metadata (restaurantInfoSchema)
//   content/contributors.json            public contributor identities
//   private/contributors.json            pending contributors and contact details (git-ignored)
// See docs/content.md for the field reference. Part of the shared data
// contract: imports nothing from src/ or scripts/.

import { z } from 'zod';
import { CUISINE_IDS, TAG_IDS, VERDICTS, type Rating } from './vocabulary';

const text = z.string().trim().min(1, 'must not be empty');

/**
 * Lowercase URL-safe identifier. Restaurant ids are generated (e.g. "r-7k3m9q")
 * and never change when the name changes.
 */
export const idSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase letters, digits, and single hyphens');

/** Contributor ids look like "u-001". */
export const contributorIdSchema = z.string().regex(/^u-\d{3,}$/, 'must look like "u-001"');

/** Path of an image inside the restaurant folder, e.g. "images/02-pho.jpg". */
export const imagePathSchema = z
  .string()
  .trim()
  .refine((value) => !/^[a-z]+:/i.test(value), {
    message: 'must be a local file, not a URL; import it with content:add-images',
  })
  .refine((value) => /^images\/[^/\\]+$/.test(value), {
    message: 'must be a file in the restaurant\'s images/ folder, e.g. "images/02-pho.jpg"',
  });

const httpUrl = z.url({ protocol: /^https?$/, message: 'must be an http(s) URL' });

const controlled = (ids: readonly string[], what: string) =>
  z.string().refine((value) => ids.includes(value), {
    message: `unknown ${what}; use one of ${ids.join(', ')}, or add it to shared/content/vocabulary.ts`,
  });

const unique = <T>(items: T[]) => new Set(items).size === items.length;

export const restaurantInfoSchema = z
  .strictObject({
  id: idSchema,
  status: z.enum(['draft', 'published'], { message: 'must be "draft" or "published"' }),
  /** Chinese and English names; at least one is required (see displayName). */
  nameZh: text.optional(),
  nameEn: text.optional(),
  /** Other names (abbreviations, former names); searchable. */
  altNames: z.array(text).optional(),
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
  cuisines: z.array(controlled(CUISINE_IDS, 'cuisine')).refine(unique, 'must not repeat').optional(),
  tags: z.array(controlled(TAG_IDS, 'tag')).refine(unique, 'must not repeat').optional(),
  rating: z
    .number()
    .int('must be a whole number from 1 (lowest) to 5 (highest)')
    .min(1, 'must be a whole number from 1 (lowest) to 5 (highest)')
    .max(5, 'must be a whole number from 1 (lowest) to 5 (highest)')
    .transform((value) => value as Rating)
    .optional(),
  pricePerPerson: z.number().positive().max(1000).optional(),
  dishes: z
    .array(
      z.strictObject({
        name: text,
        verdict: z
          .literal(VERDICTS, {
            message: 'must be 1 (recommended) or -1 (not recommended); leave it out for no opinion',
          })
          .optional(),
        comment: text.optional(),
        image: imagePathSchema.optional(),
      }),
    )
    .optional(),
  links: z
    .strictObject({
      googleMaps: httpUrl.optional(),
      appleMaps: httpUrl.optional(),
      website: httpUrl.optional(),
    })
    .optional(),
  contributorIds: z.array(contributorIdSchema).refine(unique, 'must not repeat').optional(),
})
  .refine((info) => info.nameZh !== undefined || info.nameEn !== undefined, {
    message: 'give "nameZh" (Chinese name), "nameEn" (English name), or both',
    path: ['nameZh'],
  });

export type RestaurantInfo = z.infer<typeof restaurantInfoSchema>;

/** The name shown first: the Chinese name when there is one, otherwise the English name. */
export function displayName(names: { nameZh?: string; nameEn?: string }): string {
  return names.nameZh ?? names.nameEn ?? '';
}

const notAnEmail = text.refine((value) => !value.includes('@'), {
  message: 'display names are public; keep email addresses in private/contributors.json',
});

/** content/contributors.json: public identities only (no contact details). */
export const publicContributorsSchema = z
  .array(z.strictObject({ id: contributorIdSchema, name: notAnEmail }))
  .refine((list) => unique(list.map((c) => c.id)), 'contributor ids must be unique');
export type PublicContributor = z.infer<typeof publicContributorsSchema>[number];

/**
 * private/contributors.json (git-ignored): contributors not yet public and
 * contact details. Never read by the website build.
 */
export const privateContributorsSchema = z.record(
  contributorIdSchema,
  z.strictObject({
    name: text.optional(),
    email: z.email().optional(),
    contact: text.optional(),
  }),
);
export type PrivateContributors = z.infer<typeof privateContributorsSchema>;

/** Formats zod issues as "field.path: message" lines. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
