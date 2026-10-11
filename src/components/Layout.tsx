import type { ReactNode } from 'react';
import { browseHref } from '../lib/router';
import { Link } from './Link';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-[2000] rounded bg-white px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        跳到主要内容
      </a>
      <header className="border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link
            href={browseHref()}
            className="flex items-center gap-2 rounded-lg"
            aria-label="Rice吃啥 首页"
          >
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-8" />
            <span className="text-xl font-black tracking-tight">
              Rice<span className="text-chili-600">吃啥</span>
            </span>
          </Link>
          <p className="hidden text-sm text-muted sm:block">莱斯大学周边的社区美食指南</p>
        </div>
      </header>
      <main id="main" className="flex flex-1 flex-col">
        {children}
      </main>
      <footer className="border-t border-line bg-white/60">
        <div className="mx-auto max-w-6xl space-y-1 px-4 py-6 text-xs leading-6 text-muted">
          <p>
            Rice吃啥 是独立的社区项目，与莱斯大学（Rice University）无关，也不是莱斯大学的官方服务。
          </p>
          <p>
            网站代码以 MIT 许可开源；点评、照片等内容的版权归各自作者所有，不适用 MIT 许可。
            <a
              href="https://github.com/baoyunfan0101/rice-eats"
              className="ml-1 underline hover:text-ink"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
