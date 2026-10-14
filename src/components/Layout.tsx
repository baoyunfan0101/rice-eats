import type { ReactNode } from 'react';
import { browseHref, submitHref } from '../lib/router';
import { submissionFormId } from '../lib/submission';
import { Link } from './Link';

/**
 * The page frame. With `fill`, the page takes exactly the viewport height
 * (the discovery page's list and map scroll inside it), and the page shows
 * the footer notes itself.
 */
export function Layout({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  return (
    <div className={fill ? 'flex h-dvh flex-col overflow-hidden' : 'flex min-h-dvh flex-col'}>
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
            aria-label="Rice Eats 首页"
          >
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-8" />
            <span className="text-xl font-black tracking-tight">
              Rice <span className="text-chili-600">Eats</span>
            </span>
          </Link>
          <p className="hidden text-sm text-muted sm:block">莱斯大学周边的社区美食指南</p>
          {submissionFormId() && (
            <nav aria-label="站点" className="ml-auto">
              <Link
                href={submitHref()}
                className="inline-flex min-h-10 items-center rounded-full border border-line bg-white px-4 text-sm font-semibold hover:border-chili-600"
              >
                投稿
              </Link>
            </nav>
          )}
        </div>
      </header>
      <main id="main" className={fill ? 'flex min-h-0 flex-1 flex-col' : 'flex flex-1 flex-col'}>
        {children}
      </main>
      {!fill && (
        <footer className="border-t border-line bg-white/60">
          <FooterNotes className="mx-auto max-w-6xl px-4 py-6" />
        </footer>
      )}
    </div>
  );
}

/** The project notes shown at the bottom of every page. */
export function FooterNotes({ className = '' }: { className?: string }) {
  return (
    <div className={`space-y-1 text-xs leading-6 text-muted ${className}`}>
      <p>
        Rice Eats 是独立的社区项目，与莱斯大学（Rice University）无关，也不是莱斯大学的官方服务。
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
  );
}
