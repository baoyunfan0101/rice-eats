import { useEffect, useState } from 'react';
import type { Dish, ImageAsset, RestaurantDetail } from '../../shared/content/model';
import { DraftBadge, Tags, RatingBadge, VerdictBadge } from '../components/Badges';
import { Link } from '../components/Link';
import { RestaurantImage } from '../components/RestaurantImage';
import { ErrorState, Loading, Message } from '../components/States';
import { useContentIndex, useRestaurantDetail } from '../lib/content';
import { toSearchParams, DEFAULT_STATE } from '../lib/filters';
import { cuisineLabel, VERDICT_LABELS } from '../lib/labels';
import { priceText, RATING_HINT, RATING_LABELS, secondaryNames } from '../lib/format';
import { placeImages } from '../lib/imagePlacement';
import { appleMapsUrl, googleMapsUrl } from '../lib/maps';
import { browseHref, canGoBack, submitHref } from '../lib/router';
import { submissionFormId } from '../lib/submission';

export function RestaurantPage({ id }: { id: string }) {
  const [attempt, setAttempt] = useState(0);
  const index = useContentIndex(attempt);
  const known = index.status === 'ready' && index.data.restaurants.some((r) => r.id === id);
  const detail = useRestaurantDetail(known ? id : '', attempt);

  useEffect(() => {
    if (detail.status === 'ready') document.title = `${detail.data.name} · Rice Eats`;
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
  // Each photo appears once: see src/lib/imagePlacement.ts for the rules.
  const { hero, dishImages, gallery } = placeImages(r);
  // Dishes keep their stored order within each group. No verdict means no
  // opinion, so those dishes are not listed as recommendations.
  const withImages = r.dishes.map((dish, i) => ({ dish, image: dishImages[i] }));
  const recommended = withImages.filter((d) => d.dish.verdict === 1);
  const unrated = withImages.filter((d) => d.dish.verdict === undefined);
  const avoided = withImages.filter((d) => d.dish.verdict === -1);
  const google = googleMapsUrl(r);
  const apple = appleMapsUrl(r);
  const onMap = r.location
    ? browseHref(toSearchParams({ ...DEFAULT_STATE, view: 'map', selected: r.id }))
    : undefined;

  return (
    <article className="pb-16">
      <div className="mx-auto max-w-3xl px-4 pt-4">
        <BackLink />
      </div>
      {hero && (
        <div className="mx-auto mt-3 max-w-5xl sm:px-4">
          <RestaurantImage
            image={hero}
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
              {cuisineLabel(c)}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl leading-tight font-black sm:text-4xl">{r.name}</h1>
          <RatingBadge rating={r.rating} size="lg" />
        </div>
        {secondaryNames(r).length > 0 && (
          <p className="text-muted">{secondaryNames(r).join(' / ')}</p>
        )}

        <dl className="grid gap-x-6 gap-y-2 rounded-2xl border border-line bg-white p-4 text-sm sm:grid-cols-2">
          {r.rating !== undefined && (
            <Fact label="评级" value={RATING_LABELS[r.rating]} title={RATING_HINT} />
          )}
          {r.pricePerPerson !== undefined && (
            <Fact label="人均" value={priceText(r.pricePerPerson)!.replace('人均 ', '')} />
          )}
          {r.address && <Fact label="地址" value={r.address} />}
        </dl>

        <div className="flex flex-wrap gap-2">
          {google && (
            <ActionLink href={google} external primary>
              Google 地图导航
            </ActionLink>
          )}
          {apple && (
            <ActionLink href={apple} external>
              Apple 地图导航
            </ActionLink>
          )}
          {onMap && <ActionLink href={onMap}>在本站地图中查看</ActionLink>}
          {r.links.website && (
            <ActionLink href={r.links.website} external>
              餐厅官网
            </ActionLink>
          )}
        </div>
        <Tags tags={r.tags} />
      </header>

      {r.dishes.length > 0 && (
        <section className="mx-auto mt-10 max-w-3xl px-4" aria-labelledby="dishes">
          <h2 id="dishes" className="text-xl font-bold">
            菜品
          </h2>
          <DishList dishes={recommended} />
          <DishList dishes={unrated} />
          {avoided.length > 0 && (
            <>
              <h3 className="mt-6 text-base font-semibold text-muted">{VERDICT_LABELS[-1]}</h3>
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

      {gallery.length > 0 && (
        <section className="mx-auto mt-10 max-w-3xl px-4" aria-labelledby="photos">
          <h2 id="photos" className="text-xl font-bold">
            照片
          </h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2">
            {gallery.map((image) => (
              <li key={image.src}>
                <RestaurantImage
                  image={image}
                  sizes="(min-width: 640px) 360px, 100vw"
                  className="h-auto w-full rounded-2xl"
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {submissionFormId() && (
        <aside className="mx-auto mt-12 max-w-3xl px-4" aria-labelledby="contribute">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white p-4">
            <div>
              <h2 id="contribute" className="font-bold">
                吃过这家店？
              </h2>
              <p className="text-sm text-muted">欢迎补充你的点评或照片，审核后可能会更新到这里。</p>
            </div>
            <Link
              href={submitHref(r.id)}
              className="inline-flex min-h-11 items-center rounded-full bg-chili-600 px-4 text-sm font-semibold text-white hover:bg-chili-700"
            >
              补充点评或照片
            </Link>
          </div>
        </aside>
      )}

      <footer className="mx-auto mt-12 max-w-3xl space-y-1 border-t border-line px-4 pt-6 text-sm text-muted">
        {r.contributors.length > 0 && <p>撰稿：{r.contributors.map((c) => c.name).join('、')}</p>}
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

function DishList({ dishes }: { dishes: { dish: Dish; image?: ImageAsset }[] }) {
  if (dishes.length === 0) return null;
  return (
    <ul className="mt-4 grid gap-4 sm:grid-cols-2">
      {dishes.map(({ dish, image }, i) => (
        <li
          key={`${dish.name}-${i}`}
          className="overflow-hidden rounded-2xl border border-line bg-white"
        >
          {image && (
            <RestaurantImage
              image={image}
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
