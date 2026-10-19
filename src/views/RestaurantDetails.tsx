import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Dish, ImageAsset, Rating, RestaurantDetail } from '../../shared/content/model';
import { DraftBadge, Tags, RatingBadge, VerdictBadge } from '../components/Badges';
import { Link } from '../components/Link';
import { RestaurantImage } from '../components/RestaurantImage';
import { ErrorState, Loading, Message } from '../components/States';
import { useRestaurantDetail } from '../lib/content';
import { cuisineLabel, VERDICT_LABELS } from '../lib/labels';
import { priceText, RATING_HINT, secondaryNames } from '../lib/format';
import { imagesAt, placeImages } from '../lib/imagePlacement';
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
  // Where each photo appears: see src/lib/imagePlacement.ts.
  const { hero, gallery } = placeImages(r);
  // Most recommended first; a dish nobody rated keeps its place after them.
  const dishes = [...r.dishes].sort((a, b) => b.recommend - a.recommend || a.avoid - b.avoid);
  const [openDish, setOpenDish] = useDishHash(r.dishes);
  const ids = useId();
  const google = googleMapsUrl(r);
  const apple = appleMapsUrl(r);
  const canReview = !!submissionFormId();

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
        <h1 className="text-2xl leading-tight font-black @md:text-3xl">{r.name}</h1>
        {secondaryNames(r).length > 0 && (
          <p className="text-muted">{secondaryNames(r).join(' / ')}</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <RatingSummary restaurant={r} />
          {canReview && (
            <Link href={submitHref(r.id)} className="btn btn-primary">
              点评这家餐厅
            </Link>
          )}
        </div>

        {(r.pricePerPerson !== undefined || r.address) && (
          <dl className="card grid gap-x-6 gap-y-2 p-3 text-sm @md:grid-cols-2">
            {r.pricePerPerson !== undefined && (
              <Fact label="人均" value={priceText(r.pricePerPerson)!.replace('人均 ', '')} />
            )}
            {r.address && <Fact label="地址" value={r.address} />}
          </dl>
        )}

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

      {dishes.length > 0 && (
        <section className="mt-8 px-4" aria-labelledby={`${ids}-dishes`}>
          <h2 id={`${ids}-dishes`} className="section-title">
            菜品
          </h2>
          <ul className="mt-4 grid gap-3 @md:grid-cols-2">
            {dishes.map((dish) => (
              <li key={dish.id} className="card overflow-hidden">
                {dish.imageIndexes.length > 0 && (
                  <DishPhotos name={dish.name} images={imagesAt(r, dish.imageIndexes, dish.name)} />
                )}
                <div className="space-y-1.5 p-4">
                  <h3 className="font-black">{dish.name}</h3>
                  <DishCounts dish={dish} />
                  <button
                    type="button"
                    onClick={() => setOpenDish(dish.id)}
                    className="text-action text-sm"
                  >
                    查看 {dish.reviews.length} 条评价
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8 px-4" aria-labelledby={`${ids}-reviews`}>
        <h2 id={`${ids}-reviews`} className="section-title">
          点评（{r.reviews.length}）
        </h2>
        {r.reviews.length === 0 ? (
          <p className="mt-4 text-sm text-muted">还没有点评。</p>
        ) : (
          <ol className="mt-4 space-y-4">
            {r.reviews.map((review) => (
              <li key={review.id} id={`review-${review.id}`} className="card space-y-3 p-4">
                <ReviewHeader
                  rating={review.rating}
                  name={review.contributor.name}
                  submittedAt={review.submittedAt}
                  date={review.date}
                />
                {review.html && (
                  // Sanitized at build time by scripts/content/markdown.ts.
                  <div className="review" dangerouslySetInnerHTML={{ __html: review.html }} />
                )}
                {review.dishes.some((d) => d.verdict !== undefined) && (
                  <ul className="flex flex-wrap gap-1.5" aria-label="菜品评价">
                    {review.dishes
                      .filter((d) => d.verdict !== undefined)
                      .map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            onClick={() => setOpenDish(d.id)}
                            className={`tag ${d.verdict === 1 ? 'bg-basil-50 text-basil-600' : 'bg-sand text-muted'}`}
                          >
                            {VERDICT_LABELS[d.verdict!]}：{d.name}
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
                <Thumbnails images={imagesAt(r, review.imageIndexes)} />
              </li>
            ))}
          </ol>
        )}
      </section>

      {gallery.length > 0 && (
        <section className="mt-8 px-4" aria-labelledby={`${ids}-photos`}>
          <h2 id={`${ids}-photos`} className="section-title">
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

      {canReview && (
        <aside className="mt-10 px-4" aria-labelledby={`${ids}-contribute`}>
          <div className="card flex flex-wrap items-center justify-between gap-3 bg-gold-100 p-4">
            <div>
              <h2 id={`${ids}-contribute`} className="font-black">
                吃过这家店？
              </h2>
              <p className="text-sm text-muted">欢迎写下你的点评或上传照片，审核后会显示在这里。</p>
            </div>
            <Link href={submitHref(r.id)} className="btn btn-primary">
              点评这家餐厅
            </Link>
          </div>
        </aside>
      )}

      <footer className="mx-4 mt-10 space-y-1 border-t-2 border-dashed border-ink/30 pt-5 text-sm text-muted">
        {r.contributors.length > 0 && (
          <p>点评作者：{r.contributors.map((c) => c.name).join('、')}</p>
        )}
        <p>点评内容和照片代表作者个人体验，版权归作者所有，不适用本项目代码的 MIT 许可。</p>
      </footer>

      {openDish && (
        <DishPanel
          restaurant={r}
          dish={r.dishes.find((d) => d.id === openDish)!}
          onClose={() => setOpenDish(undefined)}
        />
      )}
    </article>
  );
}

/**
 * "顶级 · 4.3 · 6 人评分", or "暂无评分". The count is of people: each
 * contributor's latest review counts once (the reviews below are all of them).
 */
function RatingSummary({ restaurant: r }: { restaurant: RestaurantDetail }) {
  if (r.rating === undefined) return <p className="text-sm font-bold text-muted">暂无评分</p>;
  return (
    <p className="flex flex-wrap items-center gap-2" title={RATING_HINT}>
      <RatingBadge rating={r.rating} size="lg" />
      <span className="font-black">{r.ratingAverage!.toFixed(1)}</span>
      <span className="text-sm text-muted" title="每人只计最近一条点评的评级">
        {r.raterCount} 人评分
      </span>
    </p>
  );
}

function DishCounts({ dish }: { dish: Dish }) {
  return (
    <p className="flex flex-wrap gap-x-3 text-sm font-bold">
      <span className="text-basil-600">
        {VERDICT_LABELS[1]} {dish.recommend}
      </span>
      <span className="text-muted">
        {VERDICT_LABELS[-1]} {dish.avoid}
      </span>
    </p>
  );
}

function ReviewHeader({
  rating,
  name,
  submittedAt,
  date,
}: {
  rating: Rating;
  name: string;
  submittedAt: string;
  date: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <RatingBadge rating={rating} />
      <span className="font-bold">{name}</span>
      <time dateTime={submittedAt} className="text-sm text-muted">
        {date}
      </time>
    </div>
  );
}

function Thumbnails({ images }: { images: ImageAsset[] }) {
  if (images.length === 0) return null;
  return (
    <ul className="grid grid-cols-3 gap-1.5">
      {images.map((image) => (
        <li key={image.src}>
          <RestaurantImage
            image={image}
            sizes="160px"
            className="aspect-square w-full border-2 border-ink"
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * The open dish, kept in the address as #dish-<id> so it can be shared, and
 * the back button closes it. Opening adds a history entry; closing goes back
 * to the page without it.
 */
function useDishHash(dishes: Dish[]): [string | undefined, (id: string | undefined) => void] {
  const read = () => {
    const id = /^#dish-(.+)$/.exec(window.location.hash)?.[1];
    return id && dishes.some((d) => d.id === decodeURIComponent(id))
      ? decodeURIComponent(id)
      : undefined;
  };
  const [open, setOpen] = useState(read);
  const pushed = useRef(false);
  useEffect(() => {
    const sync = () => setOpen(read());
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dishes]);
  const change = (id: string | undefined) => {
    const base = window.location.pathname + window.location.search;
    if (id) {
      window.history.pushState(window.history.state, '', `${base}#dish-${encodeURIComponent(id)}`);
      pushed.current = true;
    } else if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else {
      window.history.replaceState(window.history.state, '', base);
    }
    setOpen(id);
  };
  return [open, change];
}

/** Every review's word on one dish, newest first, over the page (a sheet on phones). */
function DishPanel({
  restaurant: r,
  dish,
  onClose,
}: {
  restaurant: RestaurantDetail;
  dish: Dish;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    close.current?.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Outside the details panel (a layout container that would clip it).
  return createPortal(
    <div
      className="fixed inset-0 z-[1500] flex items-end justify-center bg-ink/40 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="card max-h-[85dvh] w-full max-w-lg overflow-y-auto bg-cream sm:max-h-[80dvh]"
      >
        <div className="sticky top-0 flex items-center justify-between gap-2 border-b-2 border-ink bg-gold-300 px-4 py-2">
          <h2 id={titleId} className="font-black">
            {dish.name}
          </h2>
          <button ref={close} type="button" onClick={onClose} className="btn btn-sm">
            关闭
          </button>
        </div>
        <div className="space-y-4 p-4">
          <DishCounts dish={dish} />
          <ol className="space-y-4">
            {dish.reviews.map((m) => (
              <li
                key={m.reviewId}
                className="space-y-2 border-t-2 border-dashed border-ink/30 pt-3 first:border-t-0 first:pt-0"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <VerdictBadge verdict={m.verdict} />
                  <span className="font-bold">{m.contributor.name}</span>
                  <time dateTime={m.submittedAt} className="text-sm text-muted">
                    {m.date}
                  </time>
                </div>
                {m.comment && <p className="text-sm leading-6">{m.comment}</p>}
                <Thumbnails images={imagesAt(r, m.imageIndexes, dish.name)} />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>,
    document.body,
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
