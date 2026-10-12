import { useEffect } from 'react';
import { Link } from '../components/Link';
import { Loading, Message } from '../components/States';
import { useContentIndex } from '../lib/content';
import { browseHref, restaurantHref } from '../lib/router';
import { submissionFormId, tallyUrls, type SubmissionContext } from '../lib/submission';

/**
 * The submission page: an embedded Tally form (loaded only here) plus a direct
 * link to the Tally-hosted form as a fallback. Opened from a restaurant page,
 * it passes that restaurant's id and name to the form's hidden fields.
 */
export function SubmitPage({ restaurantId }: { restaurantId?: string }) {
  const formId = submissionFormId();

  useEffect(() => {
    document.title = '投稿 · Rice吃啥';
  }, []);

  if (!formId) {
    return (
      <Message
        icon="📝"
        title="投稿功能即将开放"
        action={
          <Link href={browseHref()} className="font-semibold text-chili-700 underline">
            返回首页
          </Link>
        }
      >
        投稿表单还在准备中，请之后再来看看。
      </Message>
    );
  }
  if (restaurantId) return <RestaurantSubmit formId={formId} restaurantId={restaurantId} />;
  return <SubmitForm formId={formId} context={{ source: 'site' }} />;
}

function RestaurantSubmit({ formId, restaurantId }: { formId: string; restaurantId: string }) {
  const index = useContentIndex(0);
  if (index.status === 'loading') return <Loading />;
  // Only restaurants the site knows are passed on; otherwise (unknown id, or
  // the content failed to load) the form simply asks for the restaurant name.
  const restaurant =
    index.status === 'ready'
      ? index.data.restaurants.find((r) => r.id === restaurantId)
      : undefined;
  const context: SubmissionContext = restaurant
    ? {
        source: 'restaurant-page',
        restaurantId: restaurant.id,
        restaurantNameZh: restaurant.nameZh,
        restaurantNameEn: restaurant.nameEn,
      }
    : { source: 'site' };
  return <SubmitForm formId={formId} context={context} name={restaurant?.name} />;
}

function SubmitForm({
  formId,
  context,
  name,
}: {
  formId: string;
  context: SubmissionContext;
  name?: string;
}) {
  const urls = tallyUrls(formId, context);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
      <header className="space-y-3">
        {context.restaurantId && (
          <Link
            href={restaurantHref(context.restaurantId)}
            className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-muted hover:text-ink"
          >
            ← {name}
          </Link>
        )}
        <h1 className="text-2xl leading-tight font-black sm:text-3xl">
          {name ? `为「${name}」投稿` : '投稿：分享你的用餐体验'}
        </h1>
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-muted">
          <li>
            {name
              ? '写几句点评、上传照片，或两者都有。'
              : '可以点评已收录的餐厅，也可以推荐还没收录的餐厅；写几句点评、上传照片，或两者都有。'}
          </li>
          <li>不需要注册账号。署名和联系邮箱都是选填，邮箱只用于和你沟通，不会公开。</li>
          <li>投稿会先经过人工审核，不会立即出现在网站上，也不保证一定发布。</li>
        </ul>
        <p className="text-sm">
          表单显示不出来？
          <a
            href={urls.direct}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 font-semibold text-chili-700 underline"
          >
            在新窗口打开投稿表单
            <span className="sr-only">（在新窗口打开）</span>
          </a>
        </p>
      </header>
      <iframe
        src={urls.embed}
        title="Rice吃啥 投稿表单"
        className="h-[75dvh] min-h-[560px] w-full rounded-2xl border border-line bg-white"
      />
    </div>
  );
}
