import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeKeyword, tagRegistrySchema } from '../../shared/content/schema.ts';
import {
  loadTags,
  matchedTagIds,
  matchKeywords,
  publishTags,
  recordDecisions,
  type TagFiles,
} from '../../scripts/content/tags.ts';
import { tempDir } from './helpers.ts';

const PUBLIC = [
  { id: 'date', label: '适合约会', aliases: ['约会'] },
  { id: 'quiet', label: '安静' },
];

async function files(): Promise<TagFiles> {
  const dir = await tempDir();
  const tagFiles = {
    publicFile: path.join(dir, 'tags.json'),
    privateFile: path.join(dir, 'private-tags.json'),
  };
  await writeFile(tagFiles.publicFile, JSON.stringify(PUBLIC));
  return tagFiles;
}
const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as unknown;

describe('tag registry', () => {
  it('normalizes width, case, spacing, and punctuation in keywords', () => {
    expect(normalizeKeyword(' 适合 约会！')).toBe('适合约会');
    expect(normalizeKeyword('Ｌａｔｅ-Night')).toBe('latenight');
  });

  it('rejects ids that are not slugs, repeated ids, and words shared by two tags', () => {
    const problems = (list: unknown) =>
      tagRegistrySchema
        .safeParse(list)
        .error?.issues.map((i) => i.message)
        .join('\n') ?? '';
    expect(problems([{ id: 'Late Night', label: 'x' }])).toMatch(/slug/);
    expect(
      problems([
        { id: 'a', label: 'x' },
        { id: 'a', label: 'y' },
      ]),
    ).toMatch(/"a"/);
    expect(
      problems([
        { id: 'a', label: '安静' },
        { id: 'b', label: 'y', aliases: ['安 静'] },
      ]),
    ).toMatch(/already belongs to tag "a"/);
    expect(problems(PUBLIC)).toBe('');
  });

  it('matches by id, label, or alias, then learned aliases, then decisions; the rest stays pending', async () => {
    const tagFiles = await files();
    await writeFile(
      tagFiles.privateFile,
      JSON.stringify({
        proposed: [{ id: 'pet-friendly', label: '可带宠物' }],
        aliases: { 很安静: 'quiet' },
      }),
    );
    const registry = await loadTags(tagFiles);
    const matches = matchKeywords(
      ['约会', 'QUIET', '很安静', '可带宠物', '份量大', '朋友推荐', '待定'],
      registry,
      [
        { keyword: '份量大', newTag: { id: 'big-portions', label: '份量大' } },
        { keyword: '朋友推荐', skip: 'not about the restaurant' },
      ],
    );
    expect(matches).toEqual([
      { keyword: '约会', tag: 'date', via: 'registry' },
      { keyword: 'QUIET', tag: 'quiet', via: 'registry' },
      { keyword: '很安静', tag: 'quiet', via: 'learned' },
      { keyword: '可带宠物', tag: 'pet-friendly', via: 'registry' },
      { keyword: '份量大', tag: 'big-portions', via: 'decision', created: true },
      { keyword: '朋友推荐', via: 'skipped', reason: 'not about the restaurant' },
      { keyword: '待定', via: 'pending' },
    ]);
    expect(matchedTagIds(matches)).toEqual(['date', 'quiet', 'pet-friendly', 'big-portions']);
  });

  it('records decisions privately and idempotently, and publishes only the label', async () => {
    const tagFiles = await files();
    const decisions = [
      { keyword: '份量大', newTag: { id: 'big-portions', label: '份量大' } },
      { keyword: '份量足', tag: 'big-portions' },
      { keyword: '很安静', tag: 'quiet' },
      { keyword: '约会', tag: 'date' },
    ];
    await recordDecisions(tagFiles, decisions);
    await recordDecisions(tagFiles, decisions);
    expect(await read(tagFiles.privateFile)).toEqual({
      proposed: [{ id: 'big-portions', label: '份量大' }],
      // 份量大 is the new tag's label and 约会 an alias already, so neither is learned.
      aliases: { 份量足: 'big-portions', 很安静: 'quiet' },
    });
    expect(await read(tagFiles.publicFile)).toEqual(PUBLIC);

    expect(await publishTags(tagFiles, ['big-portions', 'quiet', 'unknown'])).toEqual([
      'big-portions',
    ]);
    expect(await publishTags(tagFiles, ['big-portions'])).toEqual([]);
    expect(await read(tagFiles.publicFile)).toEqual([
      ...PUBLIC,
      { id: 'big-portions', label: '份量大' },
    ]);
    // Learned aliases (contributors' own words) stay private.
    expect(await read(tagFiles.privateFile)).toEqual({
      proposed: [],
      aliases: { 份量足: 'big-portions', 很安静: 'quiet' },
    });
  });

  it('reports a broken registry file by name', async () => {
    const tagFiles = await files();
    await writeFile(tagFiles.privateFile, '{"proposed": [{"id": "Bad"}]}');
    await expect(loadTags(tagFiles)).rejects.toThrow(/private-tags.json/);
  });
});
