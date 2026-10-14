import type { ReactNode } from 'react';
import { browseHref, submitHref } from '../lib/router';
import { submissionFormId } from '../lib/submission';
import { Link } from './Link';
import { Logo } from './Logo';

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
        className="btn btn-accent sr-only z-[2000] focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        跳到主要内容
      </a>
      <header className="border-b-2 border-ink bg-cream">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
          <Link href={browseHref()} className="shrink-0" aria-label="Rice Eats 首页">
            <Logo />
          </Link>
          <p className="hidden text-sm font-semibold text-muted sm:block">
            莱斯大学周边的社区美食指南
          </p>
          {submissionFormId() && (
            <nav aria-label="站点" className="ml-auto">
              <Link href={submitHref()} className="btn btn-primary btn-sm min-h-9 px-3.5">
                <span aria-hidden="true" className="font-pixel text-base leading-none">
                  +
                </span>
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
        <footer className="border-t-2 border-ink bg-sand">
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
          className="text-action ml-1 text-xs"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
      </p>
    </div>
  );
}
