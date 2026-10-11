// Serves a build directory the way GitHub Pages serves a project site:
// files and directory index.html under /rice-eats/, and 404.html (status 404)
// for anything else. Used by the end-to-end tests.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const [root = 'dist-e2e', portArg = '4173', base = '/rice-eats/'] = process.argv.slice(2);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
};

function resolve(urlPath: string): string | undefined {
  if (!urlPath.startsWith(base)) return undefined;
  const file = path.join(root, decodeURIComponent(urlPath.slice(base.length)));
  if (!path.resolve(file).startsWith(path.resolve(root))) return undefined;
  if (existsSync(file) && statSync(file).isFile()) return file;
  const index = path.join(file, 'index.html');
  if (existsSync(index)) return index;
  return undefined;
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // GitHub Pages redirects "/rice-eats" to "/rice-eats/" and "/r/x" to "/r/x/".
  const dirIndex = !url.pathname.endsWith('/') && resolve(`${url.pathname}/`);
  if (dirIndex || url.pathname === base.slice(0, -1)) {
    res.writeHead(301, { location: `${url.pathname}/${url.search}` });
    res.end();
    return;
  }
  const file = resolve(url.pathname);
  const status = file ? 200 : 404;
  const served = file ?? path.join(root, '404.html');
  res.writeHead(status, {
    'content-type': types[path.extname(served)] ?? 'application/octet-stream',
  });
  createReadStream(served).pipe(res);
}).listen(Number(portArg), () =>
  console.log(`Serving ${root} at http://localhost:${portArg}${base}`),
);
