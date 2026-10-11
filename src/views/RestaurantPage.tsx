import { useEffect, useState } from 'react';
import type { Dish, RestaurantDetail } from '../content/model';
import { DraftBadge, Tags, TierBadge, VerdictBadge } from '../components/Badges';
import { Link } from '../components/Link';
import { RestaurantImage } from '../components/RestaurantImage';
import { ErrorState, Loading, Message } from '../components/States';
import { useContentIndex, useRestaurantDetail } from '../lib/content';
import { toSearchParams, DEFAULT_STATE } from '../lib/filters';
import { priceText, TIER_HINT } from '../lib/format';
import { browseHref, canGoBack } from '../lib/router';

export function RestaurantPage({ id }: { id: string }) {
  const [attempt, setAttempt] = useState(0);
  const index = useContentIndex(attempt);
  const known = index.status === 'ready' && index.data.restaurants.some((r) => r.id === id);
  const detail = useRestaurantDetail(known ? id : '', attempt);

  useEffect(() => {
    if (detail.status === 'ready') document.title = `${detail.data.name} · Rice吃啥`;
  }, [detail]);

  const retry = () => setAttempt((n) => n + 1);
  if (index.status === 'error') return <ErrorState onRetry={retry} />;
  if (index.status === 'ready' && !known) {
    return (
      <Message
        icon="🧭"
        title="找不到这家餐厅"
        action={
          <Link href={browseHref()} className="font-semibold text-chili-700 underline">
            浏览全部餐厅
          </Link>
        }
      >
        它可能还没有发布，或者链接有误。
      </Message>
    );
  }
  if (detail.status === 'error') return <ErrorState onRetry={retry} />;
  if (detail.status !== 'ready') return <Loading />;
  return <Detail restaurant={detail.data} />;
}

function Detail({ restaurant: r }: { restaurant: RestaurantDetail }) {
  const recommended = r.dishes.filter((d) => d.verdict !== '不推荐');
  const avoided = r.dishes.filter((d) => d.verdict === '不推荐');
  const onMap = r.location
    ? browseHref(toSearchParams({ ...DEFAULT_STATE, view: 'map', selected: r.id }))
    : undefined;

  return (
    <article className="pb-16">
      <div className="mx-auto max-w-3xl px-4 pt-4">
        <BackLink />
      </div>
      {r.cover && (
        <div className="mx-auto mt-3 max-w-5xl sm:px-4">
          <RestaurantImage
            image={r.cover}
            sizes="(min-width: 1024px) 1024px, 100vw"
            eager
            className="aspect-[16/9] max-h-[60vh] w-full sm:rounded-2xl"
          />
        </div>
      )}

      <header className="mx-auto mt-6 max-w-3xl space-y-3 px-4">
        <div className="flex flex-wrap items-center gap-2">
          {r.status === 'draft' && <DraftBadge />}
          {r.cuisines.map((c) => (
            <span key={c} className="text-sm font-semibold text-chili-700">
              {c}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl leading-tight font-black sm:text-4xl">{r.name}</h1>
          <TierBadge tier={r.tier} size="lg" />
        </div>
        {r.altNames.length > 0 && <p className="text-muted">{r.altNames.join(' / ')}</p>}
        {r.summary && <p className="text-lg leading-8">{r.summary}</p>}

        <dl className="grid gap-x-6 gap-y-2 rounded-2xl border border-line bg-white p-4 text-sm sm:grid-cols-2">
          {r.tier && <Fact label="评级" value={r.tier} title={TIER_HINT} />}
          {r.pricePerPerson !== undefined && (
            <Fact label="人均" value={priceText(r.pricePerPerson)!.replace('人均 ', '')} />
          )}
          {r.neighborhood && <Fact label="区域" value={r.neighborhood} />}
          {r.address && <Fact label="地址" value={r.address} />}
        </dl>

        <div className="flex flex-wrap gap-2">
          {r.mapsUrl && (
            <ActionLink href={r.mapsUrl} external primary>
              在 Google 地图中导航
            </ActionLink>
          )}
          {onMap && <ActionLink href={onMap}>在本站地图中查看</ActionLink>}
          {r.website && (
            <ActionLink href={r.website} external>
              餐厅官网
            </ActionLink>
          )}
        </div>
        <Tags tags={r.tags} />
      </header>

      {r.dishes.length > 0 && (
        <section className="mx-auto mt-10 max-w-3xl px-4" aria-labelledby="dishes">
          <h2 id="dishes" className="text-xl font-bold">
            点菜参考
          </h2>
          <DishList dishes={recommended} />
          {avoided.length > 0 && (
            <>
              <h3 className="mt-6 text-base font-semibold text-muted">踩雷提醒</h3>
              <DishList dishes={avoided} />
            </>
          )}
        </section>
      )}

      {r.reviewHtml && (
        <section className="mx-auto mt-10 max-w-3xl px-4" aria-label="点评">
          {/* Sanitized at build time by scripts/content/markdown.ts. */}
          <div className="review" dangerouslySetInnerHTML={{ __html: r.reviewHtml }} />
        </section>
      )}

      <footer className="mx-auto mt-12 max-w-3xl space-y-1 border-t border-line px-4 pt-6 text-sm text-muted">
        {r.contributors.length > 0 && (
          <p>
            撰稿：
            {r.contributors.map((c, i) => (
              <span key={c.name}>
                {i > 0 && '、'}
                {c.url ? (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-ink"
                  >
                    {c.name}
                  </a>
                ) : (
                  c.name
                )}
              </span>
            ))}
          </p>
        )}
        <p>点评内容和照片代表作者个人体验，版权归作者所有，不适用本项目代码的 MIT 许可。</p>
      </footer>
    </article>
  );
}

function BackLink() {
  const className =
    'inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-muted hover:text-ink';
  if (canGoBack()) {
    return (
      <button type="button" onClick={() => window.history.back()} className={className}>
        ← 返回
      </button>
    );
  }
  return (
    <Link href={browseHref()} className={className}>
      ← 全部餐厅
    </Link>
  );
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex gap-3" title={title}>
      <dt className="w-10 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 font-medium">{value}</dd>
    </div>
  );
}

function ActionLink({
  href,
  external = false,
  primary = false,
  children,
}: {
  href: string;
  external?: boolean;
  primary?: boolean;
  children: string;
}) {
  const className = primary
    ? 'inline-flex min-h-11 items-center rounded-full bg-chili-600 px-4 text-sm font-semibold text-white hover:bg-chili-700'
    : 'inline-flex min-h-11 items-center rounded-full border border-line bg-white px-4 text-sm font-semibold hover:border-chili-600';
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
        <span className="sr-only">（在新窗口打开）</span>
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

function DishList({ dishes }: { dishes: Dish[] }) {
  return (
    <ul className="mt-4 grid gap-4 sm:grid-cols-2">
      {dishes.map((dish) => (
        <li key={dish.name} className="overflow-hidden rounded-2xl border border-line bg-white">
          {dish.image && (
            <RestaurantImage
              image={dish.image}
              sizes="(min-width: 640px) 360px, 100vw"
              className="aspect-[4/3] w-full"
            />
          )}
          <div className="space-y-1.5 p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-bold">{dish.name}</h3>
              <VerdictBadge verdict={dish.verdict} />
            </div>
            {dish.comment && <p className="text-sm leading-6 text-muted">{dish.comment}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}
