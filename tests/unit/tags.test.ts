import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeKeyword, tagRegistrySchema } from '../../shared/content/schema.ts';
import {
  loadTags,
  matchedTagIds,
  matchKeywords,
  publishTags,
  recordDecisions,
  withdrawTags,
  type TagFiles,
} from '../../scripts/content/tags.ts';
import { tagTextProblems } from '../../scripts/content/privacy.ts';
import { checkTrackedFiles } from '../../scripts/check-privacy.ts';
import { runPipeline } from '../../scripts/content/pipeline.ts';
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

  it('withdraws proposed tags and the aliases that point to them', async () => {
    const tagFiles = await files();
    await recordDecisions(tagFiles, [
      { keyword: '份量大', newTag: { id: 'big-portions', label: '份量大' } },
      { keyword: '份量足', tag: 'big-portions' },
      { keyword: '很安静', tag: 'quiet' },
    ]);
    await withdrawTags(tagFiles, new Set(['big-portions']));
    expect(await read(tagFiles.privateFile)).toEqual({
      proposed: [],
      aliases: { 很安静: 'quiet' },
    });
  });
});

describe('tag privacy', () => {
  const SAFE = [
    '实惠',
    '适合约会',
    'date night',
    '营业到很晚',
    '可带宠物（示例）',
    '24小时',
    '2人套餐',
    'big portions',
    'pet-friendly',
  ];
  const UNSAFE = [
    'boss@example.com',
    '@riceeats',
    'vx dumpling88',
    '微信：dumpling88',
    'QQ 12345678',
    '7135550199',
    '713-555-0199',
    'ig: foodie',
    'dumplings.com',
    'https://x.example',
    'tally.so/r/abc',
    'aB3dE5fG7hJ9kL1mN3',
  ];
  const QUESTIONABLE = ['微信支付', '加微信', '可以给手机充电', 'abc123', '小红书同款'];

  it('blocks obvious contact details, flags questionable words, and allows descriptive tags', () => {
    for (const word of SAFE)
      expect(tagTextProblems(word), word).toEqual({ unsafe: [], questionable: [] });
    for (const word of UNSAFE) expect(tagTextProblems(word).unsafe, word).not.toEqual([]);
    for (const word of QUESTIONABLE) {
      expect(tagTextProblems(word), word).toMatchObject({ unsafe: [] });
      expect(tagTextProblems(word).questionable, word).not.toEqual([]);
    }
  });

  it('never records or publishes an unsafe proposal', async () => {
    const tagFiles = await files();
    await recordDecisions(tagFiles, [
      { keyword: '加我', newTag: { id: 'contact', label: 'vx dumpling88' } },
    ]);
    expect(existsSync(tagFiles.privateFile)).toBe(false);
    // Even when written into private/tags.json by hand.
    await writeFile(
      tagFiles.privateFile,
      JSON.stringify({ proposed: [{ id: 'contact', label: '电话 7135550199' }], aliases: {} }),
    );
    await expect(publishTags(tagFiles, ['contact'])).rejects.toThrow(
      /not published: .*phone number/,
    );
    expect(await read(tagFiles.publicFile)).toEqual(PUBLIC);
  });

  it('fails the content check and the privacy check for contact details in a tag registry', async () => {
    const dir = await tempDir();
    const tagsFile = path.join(dir, 'content/tags.json');
    await mkdir(path.dirname(tagsFile), { recursive: true });
    await writeFile(
      tagsFile,
      JSON.stringify([
        ...PUBLIC,
        { id: 'deals', label: '优惠', aliases: ['加微信 dumpling88'] },
        { id: 'pay', label: '微信支付' },
      ]),
    );
    const result = await runPipeline({
      restaurantsDir: path.join(dir, 'content/restaurants'),
      contributorsFile: path.join(dir, 'content/contributors.json'),
      tagsFile,
      source: 'content',
      includeDrafts: false,
      base: '/',
      cacheDir: path.join(dir, '.cache'),
    });
    expect(result.failed).toBe(true);
    expect(
      result.diagnostics
        .filter((d) => d.level === 'error')
        .map((d) => d.message)
        .join('\n'),
    ).toMatch(/tag "deals" alias "加微信 dumpling88": a contact handle/);
    expect(
      result.diagnostics
        .filter((d) => d.level === 'warning')
        .map((d) => d.message)
        .join('\n'),
    ).toMatch(/tag "pay" label "微信支付"/);
    expect((await checkTrackedFiles(dir, ['content/tags.json'])).join('\n')).toMatch(
      /content\/tags.json: tag "deals" alias .*a contact handle/,
    );
  });
});
