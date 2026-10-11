import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// The Skill, AGENTS.md, and docs must describe commands that actually exist.
const DOCS = [
  '.claude/skills/restaurant-intake/SKILL.md',
  'AGENTS.md',
  'README.md',
  'docs/content.md',
];

describe('documentation', () => {
  it('only references npm scripts that exist', async () => {
    const scripts = Object.keys(
      JSON.parse(await readFile('package.json', 'utf8')).scripts as object,
    );
    for (const doc of DOCS) {
      const text = await readFile(doc, 'utf8');
      for (const [, name] of text.matchAll(/npm run ([a-z0-9:-]*[a-z0-9])/g)) {
        expect(scripts, `${doc} mentions "npm run ${name}"`).toContain(name);
      }
    }
  });

  it('describes the same private-draft workflow in the Skill, AGENTS.md, and the CLI', async () => {
    const cli = await readFile('scripts/content/cli.ts', 'utf8');
    const skill = await readFile('.claude/skills/restaurant-intake/SKILL.md', 'utf8');
    const agents = await readFile('AGENTS.md', 'utf8');
    const content = await readFile('docs/content.md', 'utf8');
    for (const command of [
      'content:new',
      'content:add-images',
      'content:check',
      'content:promote',
      'content:publish',
    ]) {
      expect(skill, command).toContain(`npm run ${command}`);
      expect(content, command).toContain(`npm run ${command}`);
      expect(cli, command).toMatch(new RegExp(`\\n  ${command.split(':')[1]} [<\\[]`));
    }
    for (const text of [skill, agents, content]) {
      expect(text).toContain('drafts/');
      expect(text).toContain('--approved');
    }
  });
});
