// The canonical database formats:
//   content/restaurants/<id>/info.json   restaurant facts and its dishes (restaurantInfoSchema)
//   content/restaurants/<id>/reviews/<contributor id>.json (+ .md)
//                                        one contributor's review (reviewSchema)
//   content/contributors.json            public contributor identities
//   content/tags.json                    the public tag registry
//   private/contributors.json            pending contributors and contact details (git-ignored)
//   private/tags.json                    proposed tags and learned keyword aliases (git-ignored)
// See docs/content.md for the field reference. Part of the shared data
// contract: imports nothing from src/ or scripts/.

import { z } from 'zod';
import { CUISINE_IDS, VERDICTS, type Rating } from './vocabulary';

const text = z.string().trim().min(1, 'must not be empty');

/**
 * Lowercase URL-safe identifier. Restaurant ids are generated (e.g. "r-7k3m9q")
 * and never change when the name changes.
 */
export const idSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase letters, digits, and single hyphens');

/** Dish ids are short slugs, unique within a restaurant, e.g. "d1". */
export const dishIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a slug such as "d1"');

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

/** Tag ids are stable, language-independent slugs, e.g. "date" or "pet-friendly". */
export const tagIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug such as "pet-friendly"')
  .max(40, 'must be at most 40 characters');

/** Normalized form of a tag label or keyword, for matching (case, width, spaces, punctuation). */
export const normalizeKeyword = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

const tagDefinition = z.strictObject({
  id: tagIdSchema,
  /** The label shown on the website (Simplified Chinese). */
  label: text.max(20, 'must be at most 20 characters').refine((v) => !v.includes('@'), 'must not contain "@"'),
  /** Other words contributors use for this tag; matched after normalizeKeyword. */
  aliases: z.array(text.max(40)).optional(),
});
export type TagDefinition = z.infer<typeof tagDefinition>;

/** Ids are unique, and no label or alias belongs to two tags. */
const tagList = z.array(tagDefinition).superRefine((list, ctx) => {
  const ids = new Set<string>();
  const words = new Map<string, string>();
  list.forEach((tag, i) => {
    if (ids.has(tag.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate tag id "${tag.id}"` });
    ids.add(tag.id);
    for (const word of [tag.id, tag.label, ...(tag.aliases ?? [])]) {
      const key = normalizeKeyword(word);
      const owner = words.get(key);
      if (owner && owner !== tag.id) {
        ctx.addIssue({ code: 'custom', path: [i], message: `"${word}" already belongs to tag "${owner}"` });
      }
      words.set(key, tag.id);
    }
  });
});

/**
 * content/tags.json: the public tag registry. Restaurants store tag ids; the
 * website shows the labels. New tags are proposed privately and added here
 * when a restaurant using them is promoted.
 */
export const tagRegistrySchema = tagList;

/**
 * private/tags.json (git-ignored): tags proposed during intake that no
 * promoted restaurant uses yet, and keyword aliases learned from reviewed
 * submissions (normalized keyword -> tag id), reused for later submissions.
 */
export const privateTagsSchema = z.strictObject({
  proposed: tagList.default([]),
  aliases: z.record(z.string(), tagIdSchema).default({}),
});
export type PrivateTags = z.infer<typeof privateTagsSchema>;

export const restaurantInfoSchema = z
  .strictObject({
  id: idSchema,
  status: z.enum(['draft', 'published'], { message: 'must be "draft" or "published"' }),
  /** The display name, in whatever language the restaurant is best known by. */
  name: text,
  /** Other names in any language (translations, abbreviations, former names); searchable. */
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
  /** Ids from the tag registry (content/tags.json); checked against it by the pipeline. */
  tags: z.array(tagIdSchema).refine(unique, 'must not repeat').optional(),
  pricePerPerson: z.number().positive().max(1000).optional(),
  /** The restaurant's dishes; reviews give their verdicts, comments, and photos. */
  dishes: z
    .array(
      z.strictObject({
        /** Stable within the restaurant (e.g. "d1"); reviews refer to it. */
        id: dishIdSchema,
        name: text,
        /** Other names contributors used for this dish; matched like tag aliases. */
        altNames: z.array(text).optional(),
      }),
    )
    .refine((list) => unique(list.map((d) => d.id)), 'dish ids must be unique')
    .optional(),
  links: z
    .strictObject({
      googleMaps: httpUrl.optional(),
      appleMaps: httpUrl.optional(),
      website: httpUrl.optional(),
    })
    .optional(),
});

export type RestaurantInfo = z.infer<typeof restaurantInfoSchema>;

const rating = z
  .number()
  .int('must be a whole number from 1 (lowest) to 5 (highest)')
  .min(1, 'must be a whole number from 1 (lowest) to 5 (highest)')
  .max(5, 'must be a whole number from 1 (lowest) to 5 (highest)')
  .transform((value) => value as Rating);

const images = z
  .array(imagePathSchema)
  .min(1, 'leave "images" out when there is no photo')
  .refine(unique, 'must not repeat');

/**
 * content/restaurants/<id>/reviews/<contributor id>.json: one contributor's
 * review of the restaurant (one per contributor; a later submission by the
 * same contributor updates it). The review text, if any, is the .md file
 * with the same name. Photos are stored in the restaurant's images/ and
 * belong to one review each.
 */
export const reviewSchema = z.strictObject({
  /** The day the review was submitted (or last updated), YYYY-MM-DD. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like "2026-10-14"'),
  rating,
  /** Photos of the restaurant (not of one dish), in display order. */
  images: images.optional(),
  dishes: z
    .array(
      z.strictObject({
        /** An id from the restaurant's "dishes". */
        dish: dishIdSchema,
        verdict: z
          .literal(VERDICTS, {
            message: 'must be 1 (recommended) or -1 (not recommended); leave it out for no opinion',
          })
          .optional(),
        comment: text.optional(),
        /** Every photo of this dish in this review, in display order. */
        images: images.optional(),
      }),
    )
    .refine((list) => unique(list.map((d) => d.dish)), 'a dish appears once per review')
    .optional(),
});
export type Review = z.infer<typeof reviewSchema>;

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
