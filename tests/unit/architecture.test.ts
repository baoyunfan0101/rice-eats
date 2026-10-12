import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Dependency rules between the three layers:
//   shared/   data contract (schema, generated-data model, vocabulary): imports only shared/ and libraries
//   scripts/  content management: may import shared/, never src/
//   src/      website: may import shared/, never scripts/
async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

async function localImports(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)].map((m) =>
    path.relative(process.cwd(), path.resolve(path.dirname(file), m[1]!)),
  );
}

const layer = (file: string) => file.split(path.sep)[0]!;

describe('module boundaries', () => {
  it.each([
    ['shared', ['shared']],
    ['scripts', ['shared', 'scripts', 'site.config.ts']],
    ['src', ['shared', 'src']],
  ])('%s/ only imports from %j', async (dir, allowed) => {
    const violations: string[] = [];
    for (const file of await sources(dir)) {
      for (const target of await localImports(file)) {
        if (!allowed.includes(layer(target))) violations.push(`${file} -> ${target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('defines the controlled vocabulary in one place', async () => {
    const files = [
      ...(await sources('shared')),
      ...(await sources('scripts')),
      ...(await sources('src')),
    ];
    const definers: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (/export const (CUISINE_IDS|TAG_IDS|RATINGS|VERDICTS)\b/.test(text)) definers.push(file);
    }
    expect(definers).toEqual([path.join('shared', 'content', 'vocabulary.ts')]);
  });

  it('validates canonical content with the shared schema alone', async () => {
    // shared/ imports nothing from src/ (checked above), so this loads no website code.
    const { restaurantInfoSchema } = await import('../../shared/content/schema.ts');
    expect(
      restaurantInfoSchema.safeParse({
        id: 'r-abc123',
        status: 'draft',
        name: 'x',
        rating: 2,
        dishes: [{ name: 'y', verdict: -1 }],
      }).success,
    ).toBe(true);
  });
});
