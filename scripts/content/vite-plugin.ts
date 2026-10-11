// Dev-server integration: builds content on startup and rebuilds it whenever
// files under the content folder change, then reloads the page.

import path from 'node:path';
import type { Plugin } from 'vite';
import { BASE_PATH } from '../../site.config.ts';
import { IMAGE_CACHE_DIR, OUT_DIR, RESTAURANT_DIRS, draftsFromEnv, sourceFromEnv } from './paths.ts';
import { runPipeline } from './pipeline.ts';
import { printDiagnostics } from './report.ts';

export function contentDevPlugin(): Plugin {
  return {
    name: 'rice-eats-content',
    apply: (_config, env) => env.command === 'serve' && !process.env.VITEST,
    async configureServer(server) {
      const source = sourceFromEnv();
      const restaurantsDir = RESTAURANT_DIRS[source];
      const includeDrafts = draftsFromEnv();
      let running: Promise<void> | undefined;
      let queued = false;

      const build = async () => {
        const result = await runPipeline({
          restaurantsDir,
          source,
          includeDrafts,
          base: BASE_PATH,
          cacheDir: IMAGE_CACHE_DIR,
          outDir: OUT_DIR,
        });
        printDiagnostics(result.diagnostics, (line) => server.config.logger.warn(line));
        server.config.logger.info(
          result.failed
            ? '[content] build failed; the site keeps the previous content'
            : `[content] ${result.details.length} restaurant(s) from ${source}` +
                (includeDrafts ? ' (drafts included)' : ''),
        );
      };
      const rebuild = () => {
        if (running) {
          queued = true;
          return;
        }
        running = build()
          .catch((error: unknown) => server.config.logger.error(String(error)))
          .finally(() => {
            running = undefined;
            if (queued) {
              queued = false;
              rebuild();
            } else {
              server.ws.send({ type: 'full-reload' });
            }
          });
      };

      await build();
      server.watcher.add(restaurantsDir);
      const onChange = (file: string) => {
        if (file.startsWith(restaurantsDir + path.sep)) rebuild();
      };
      server.watcher.on('add', onChange);
      server.watcher.on('change', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
}
