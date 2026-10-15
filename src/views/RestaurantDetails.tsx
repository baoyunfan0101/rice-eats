import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { Dish, ImageAsset, RestaurantDetail } from '../../shared/content/model';
import { DraftBadge, Tags, RatingBadge, VerdictBadge } from '../components/Badges';
import { Link } from '../components/Link';
import { RestaurantImage } from '../components/RestaurantImage';
import { ErrorState, Loading, Message } from '../components/States';
import { useRestaurantDetail } from '../lib/content';
import { cuisineLabel, VERDICT_LABELS } from '../lib/labels';
import { priceText, RATING_HINT, RATING_LABELS, secondaryNames } from '../lib/format';
import { placeImages } from '../lib/imagePlacement';
import { appleMapsUrl, googleMapsUrl } from '../lib/maps';
import { submitHref } from '../lib/router';
import { submissionFormId } from '../lib/submission';

/**
 * A restaurant's details, shown in the discovery page's list area (beside the
 * map on wide screens, in the bottom sheet on phones) while the map selects it.
 * `known` says whether the published index has the restaurant (undefined while
 * that is not known yet).
 */
export function RestaurantDetails({
  id,
  known,
  onBack,
}: {
  id: string;
  known: boolean;
  /** Returns to the list. */
  onBack: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const detail = useRestaurantDetail(known ? id : '', attempt);

  useEffect(() => {
    if (detail.status === 'ready') document.title = `${detail.data.name} · Rice Eats`;
  }, [detail]);

  let body;
  if (!known) {
    body = (
      <Message
        icon="🧭"
        title="找不到这家餐厅"
        action={
          <button type="button" onClick={onBack} className="btn btn-primary">
            浏览全部餐厅
          </button>
        }
      >
        它可能还没有发布，或者链接有误。
      </Message>
    );
  } else if (detail.status === 'error') {
    body = <ErrorState onRetry={() => setAttempt((n) => n + 1)} />;
  } else if (detail.status !== 'ready') {
    body = <Loading />;
  } else {
    body = <Detail restaurant={detail.data} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* On phones the bottom sheet is dragged by this bar too (its non-control parts). */}
      <div
        data-sheet-drag
        className="flex shrink-0 touch-pan-x items-center border-b-2 border-ink px-2 pt-0.5 pb-1.5"
      >
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-10 items-center gap-1 px-2 text-sm font-bold text-muted hover:text-chili-700"
        >
          ← 返回列表
        </button>
      </div>
      <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain">{body}</div>
    </div>
  );
}

function Detail({ restaurant: r }: { restaurant: RestaurantDetail }) {
  // Each photo appears once: see src/lib/imagePlacement.ts for the rules.
  const { hero, dishImages, gallery } = placeImages(r);
  // Dishes keep their stored order within each group. No verdict means no
  // opinion, so those dishes are not listed as recommendations.
  const withImages = r.dishes.map((dish, i) => ({ dish, images: dishImages[i] ?? [] }));
  const recommended = withImages.filter((d) => d.dish.verdict === 1);
  const unrated = withImages.filter((d) => d.dish.verdict === undefined);
  const avoided = withImages.filter((d) => d.dish.verdict === -1);
  const google = googleMapsUrl(r);
  const apple = appleMapsUrl(r);

  return (
    <article className="pb-10">
      {hero && (
        <RestaurantImage
          image={hero}
          sizes="(min-width: 768px) 512px, 100vw"
          eager
          className="aspect-[16/9] w-full border-b-2 border-ink"
        />
      )}

      <header className="mt-4 space-y-3 px-4">
        <div className="flex flex-wrap items-center gap-2">
          {r.status === 'draft' && <DraftBadge />}
          {r.cuisines.map((c) => (
            <span key={c} className="tag bg-chili-50 text-chili-700">
              {cuisineLabel(c)}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl leading-tight font-black @md:text-3xl">{r.name}</h1>
          <RatingBadge rating={r.rating} size="lg" />
        </div>
        {secondaryNames(r).length > 0 && (
          <p className="text-muted">{secondaryNames(r).join(' / ')}</p>
        )}

        <dl className="card grid gap-x-6 gap-y-2 p-3 text-sm @md:grid-cols-2">
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
          {r.links.website && (
            <ActionLink href={r.links.website} external>
              餐厅官网
            </ActionLink>
          )}
        </div>
        <Tags tags={r.tags} />
      </header>

      {r.dishes.length > 0 && (
        <section className="mt-8 px-4" aria-labelledby="dishes">
          <h2 id="dishes" className="section-title">
            菜品
          </h2>
          <DishList dishes={recommended} />
          <DishList dishes={unrated} />
          {avoided.length > 0 && (
            <>
              <h3 className="mt-8 text-base font-bold text-muted">{VERDICT_LABELS[-1]}</h3>
              <DishList dishes={avoided} />
            </>
          )}
        </section>
      )}

      {r.reviewHtml && (
        <section className="mt-8 px-4" aria-label="点评">
          {/* Sanitized at build time by scripts/content/markdown.ts. */}
          <div className="review" dangerouslySetInnerHTML={{ __html: r.reviewHtml }} />
        </section>
      )}

      {gallery.length > 0 && (
        <section className="mt-8 px-4" aria-labelledby="photos">
          <h2 id="photos" className="section-title">
            照片
          </h2>
          <ul className="mt-4 grid gap-3 @md:grid-cols-2">
            {gallery.map((image) => (
              <li key={image.src}>
                <RestaurantImage
                  image={image}
                  sizes="(min-width: 768px) 256px, 100vw"
                  className="h-auto w-full border-2 border-ink"
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {submissionFormId() && (
        <aside className="mt-10 px-4" aria-labelledby="contribute">
          <div className="card flex flex-wrap items-center justify-between gap-3 bg-gold-100 p-4">
            <div>
              <h2 id="contribute" className="font-black">
                吃过这家店？
              </h2>
              <p className="text-sm text-muted">欢迎补充你的点评或照片，审核后可能会更新到这里。</p>
            </div>
            <Link href={submitHref(r.id)} className="btn btn-primary">
              补充点评或照片
            </Link>
          </div>
        </aside>
      )}

      <footer className="mx-4 mt-10 space-y-1 border-t-2 border-dashed border-ink/30 pt-5 text-sm text-muted">
        {r.contributors.length > 0 && <p>撰稿：{r.contributors.map((c) => c.name).join('、')}</p>}
        <p>点评内容和照片代表作者个人体验，版权归作者所有，不适用本项目代码的 MIT 许可。</p>
      </footer>
    </article>
  );
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex gap-3" title={title}>
      <dt className="w-10 shrink-0 font-bold text-muted">{label}</dt>
      <dd className="min-w-0 font-semibold">{value}</dd>
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
  const className = primary ? 'btn btn-primary' : 'btn';
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

function DishList({ dishes }: { dishes: { dish: Dish; images: ImageAsset[] }[] }) {
  if (dishes.length === 0) return null;
  return (
    <ul className="mt-4 grid gap-3 @md:grid-cols-2">
      {dishes.map(({ dish, images }, i) => (
        <li key={`${dish.name}-${i}`} className="card overflow-hidden">
          {images.length > 0 && <DishPhotos name={dish.name} images={images} />}
          <div className="space-y-1.5 p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-black">{dish.name}</h3>
              <VerdictBadge verdict={dish.verdict} />
            </div>
            {dish.comment && <p className="text-sm leading-6 text-muted">{dish.comment}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * A dish's photos: one large photo, and with several photos a row of
 * thumbnails to switch between them (buttons; the arrow keys move between
 * them too). Every photo of the dish is reachable here.
 */
export function DishPhotos({ name, images }: { name: string; images: ImageAsset[] }) {
  const [current, setCurrent] = useState(0);
  const id = useId();
  const shown = images[Math.min(current, images.length - 1)]!;
  const many = images.length > 1;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (current + step + images.length) % images.length;
    setCurrent(next);
    e.currentTarget.querySelectorAll('button')[next]?.focus();
  };
  return (
    <div className="border-b-2 border-ink">
      <div className="relative" id={`${id}-photo`} aria-live="polite">
        <RestaurantImage
          image={shown}
          sizes="(min-width: 768px) 256px, 100vw"
          className="aspect-[4/3] w-full"
        />
        {many && (
          <span className="absolute top-2 right-2 border-2 border-ink bg-cream px-1.5 text-xs leading-5 font-black shadow-px-sm">
            {current + 1}/{images.length}
          </span>
        )}
      </div>
      {many && (
        <div
          role="group"
          aria-label={`${name}的照片，共 ${images.length} 张`}
          onKeyDown={onKey}
          className="flex gap-1.5 overflow-x-auto border-t-2 border-ink bg-sand p-1.5"
        >
          {images.map((image, n) => (
            <button
              key={image.src}
              type="button"
              aria-label={`查看第 ${n + 1} 张照片`}
              aria-pressed={n === current}
              aria-controls={`${id}-photo`}
              tabIndex={n === current ? 0 : -1}
              onClick={() => setCurrent(n)}
              className={`size-12 shrink-0 border-2 border-ink ${
                n === current
                  ? 'shadow-px-sm outline-2 outline-offset-1 outline-chili-600'
                  : 'opacity-70 hover:opacity-100'
              }`}
            >
              <RestaurantImage image={image} sizes="48px" decorative className="size-full" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
