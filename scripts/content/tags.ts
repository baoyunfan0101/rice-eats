// The tag registry: public tags (content/tags.json) and, privately
// (private/tags.json), tags proposed during intake plus keyword aliases
// learned from reviewed submissions. Contributors type free-form keywords;
// intake maps each one to a tag here, deterministically when the registry
// already knows the word, and otherwise leaves it for a reviewed decision
// (the restaurant-intake Skill, see prepare.ts). Nothing here invents tags.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeKeyword,
  privateTagsSchema,
  tagRegistrySchema,
  type PrivateTags,
  type TagDefinition,
} from '../../shared/content/schema.ts';
import { IntakeError } from './intake.ts';

export interface TagFiles {
  publicFile: string;
  privateFile: string;
}

export interface TagRegistry {
  /** content/tags.json, in file order. */
  public: TagDefinition[];
  /** private/tags.json: proposed tags and learned aliases. */
  private: PrivateTags;
}

export async function loadTags({ publicFile, privateFile }: TagFiles): Promise<TagRegistry> {
  const read = async <T>(file: string, schema: { parse: (v: unknown) => T }, empty: T): Promise<T> => {
    if (!existsSync(file)) return empty;
    try {
      return schema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (e) {
      throw new IntakeError(`${file}: ${(e as Error).message.split('\n')[0]}`);
    }
  };
  return {
    public: await read(publicFile, tagRegistrySchema, []),
    private: await read(privateFile, privateTagsSchema, { proposed: [], aliases: {} }),
  };
}

/** Every tag a draft may use: public ones first, then proposed ones. */
export const allTags = (registry: TagRegistry) => [...registry.public, ...registry.private.proposed];

export type KeywordMatch =
  /** The registry knows the word: the tag's id, label, or one of its aliases. */
  | { keyword: string; tag: string; via: 'registry' }
  /** An earlier reviewed submission mapped this word to the tag. */
  | { keyword: string; tag: string; via: 'learned' }
  /** A reviewed decision for this submission (resolutions.json). */
  | { keyword: string; tag: string; via: 'decision'; created?: boolean }
  /** Reviewed and deliberately not used as a tag (e.g. not about the restaurant). */
  | { keyword: string; via: 'skipped'; reason: string }
  /** Unknown word: needs a decision before it can become a tag. */
  | { keyword: string; via: 'pending' };

/** The tag a word names directly (id, label, or alias), if any. */
export function lookupTag(registry: TagRegistry, word: string): TagDefinition | undefined {
  const key = normalizeKeyword(word);
  if (!key) return undefined;
  return allTags(registry).find((tag) =>
    [tag.id, tag.label, ...(tag.aliases ?? [])].some((w) => normalizeKeyword(w) === key),
  );
}

/** A reviewed decision about one keyword (validated in prepare.ts). */
export type TagDecision =
  | { keyword: string; tag: string }
  | { keyword: string; newTag: { id: string; label: string } }
  | { keyword: string; skip: string };

/**
 * Maps the contributor's keywords to tag ids: registry words first, then
 * learned aliases, then this submission's reviewed decisions. Anything else
 * stays pending; nothing is guessed.
 */
export function matchKeywords(
  keywords: string[],
  registry: TagRegistry,
  decisions: TagDecision[] = [],
): KeywordMatch[] {
  return keywords.map((keyword): KeywordMatch => {
    const direct = lookupTag(registry, keyword);
    if (direct) return { keyword, tag: direct.id, via: 'registry' };
    const learned = registry.private.aliases[normalizeKeyword(keyword)];
    if (learned && allTags(registry).some((t) => t.id === learned)) return { keyword, tag: learned, via: 'learned' };
    const decision = decisions.find((d) => normalizeKeyword(d.keyword) === normalizeKeyword(keyword));
    if (decision && 'skip' in decision) return { keyword, via: 'skipped', reason: decision.skip };
    if (decision && 'tag' in decision) return { keyword, tag: decision.tag, via: 'decision' };
    if (decision && 'newTag' in decision) {
      return { keyword, tag: decision.newTag.id, via: 'decision', created: !allTags(registry).some((t) => t.id === decision.newTag.id) };
    }
    return { keyword, via: 'pending' };
  });
}

/** Tag ids of the matches, in keyword order, each once. */
export const matchedTagIds = (matches: KeywordMatch[]) => [
  ...new Set(matches.flatMap((m) => ('tag' in m ? [m.tag] : []))),
];

async function writePrivate(file: string, data: PrivateTags) {
  const checked = privateTagsSchema.parse(data);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(checked, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/**
 * Records reviewed decisions privately: new tags become proposals, and each
 * decided keyword becomes a learned alias, so the next submission with the
 * same word needs no decision. Idempotent.
 */
export async function recordDecisions(files: TagFiles, decisions: TagDecision[]): Promise<void> {
  const registry = await loadTags(files);
  const next: PrivateTags = {
    proposed: [...registry.private.proposed],
    aliases: { ...registry.private.aliases },
  };
  for (const decision of decisions) {
    if ('newTag' in decision && !allTags({ ...registry, private: next }).some((t) => t.id === decision.newTag.id)) {
      next.proposed.push({ id: decision.newTag.id, label: decision.newTag.label });
    }
    const id = 'tag' in decision ? decision.tag : 'newTag' in decision ? decision.newTag.id : undefined;
    const key = normalizeKeyword(decision.keyword);
    if (id && key && !lookupTag({ ...registry, private: next }, decision.keyword)) next.aliases[key] = id;
  }
  if (JSON.stringify(next) !== JSON.stringify(registry.private)) await writePrivate(files.privateFile, next);
}

/**
 * Moves the proposed tags among `ids` into the public registry (the label
 * only; learned aliases stay private). Called by content:promote, like
 * publishContributors. Returns the ids that became public.
 */
export async function publishTags(files: TagFiles, ids: string[]): Promise<string[]> {
  const registry = await loadTags(files);
  const added = registry.private.proposed.filter(
    (t) => ids.includes(t.id) && !registry.public.some((p) => p.id === t.id),
  );
  if (added.length === 0) return [];
  const publicList = tagRegistrySchema.parse([...registry.public, ...added.map(({ id, label }) => ({ id, label }))]);
  await mkdir(path.dirname(files.publicFile), { recursive: true });
  await writeFile(files.publicFile, `${JSON.stringify(publicList, null, 2)}\n`);
  await writePrivate(files.privateFile, {
    ...registry.private,
    proposed: registry.private.proposed.filter((t) => !added.includes(t)),
  });
  return added.map((t) => t.id);
}
