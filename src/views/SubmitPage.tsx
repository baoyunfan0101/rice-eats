import { useEffect, useRef, useState } from 'react';
import { Link } from '../components/Link';
import { Loading, Message } from '../components/States';
import { useContentIndex } from '../lib/content';
import { browseHref, restaurantHref } from '../lib/router';
import {
  contextProblem,
  submissionFormId,
  tallyUrls,
  type SubmissionContext,
} from '../lib/submission';
import { RestaurantSelector, selectionKey, type MapView } from './RestaurantSelector';
import type { Selection } from './submitTypes';

/**
 * The submission page, in two steps: 第一步 choose a restaurant on the map
 * (selecting and checking it happen in place), 第二步 fill in the embedded
 * Tally form (loaded only here). Arriving from a restaurant page starts at
 * step 2 with that restaurant, and "更换餐厅" goes back to step 1. The chosen
 * restaurant reaches the form as hidden fields.
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
  if (restaurantId) return <ExistingRestaurant formId={formId} restaurantId={restaurantId} />;
  return <SubmitFlow formId={formId} />;
}

function ExistingRestaurant({ formId, restaurantId }: { formId: string; restaurantId: string }) {
  const index = useContentIndex(0);
  if (index.status === 'loading') return <Loading />;
  // Only restaurants the site knows are used; otherwise (unknown id, or the
  // content failed to load) the visitor chooses the restaurant.
  const r =
    index.status === 'ready'
      ? index.data.restaurants.find((x) => x.id === restaurantId)
      : undefined;
  const initial: Selection | undefined = r && {
    method: 'existing',
    restaurantId: r.id,
    name: r.name,
    address: r.address,
    location: r.location,
  };
  return <SubmitFlow formId={formId} initial={initial} />;
}

type Step = 'select' | 'form';

function SubmitFlow({ formId, initial }: { formId: string; initial?: Selection }) {
  const [step, setStep] = useState<Step>(initial ? 'form' : 'select');
  const [selection, setSelection] = useState<Selection | undefined>(initial);
  // Where the map was, so going back to step 1 keeps the contributor's place.
  const [mapView, setMapView] = useState<MapView>();
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  // Move focus to the page heading when the step changes (not on first render).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
    window.scrollTo(0, 0);
  }, [step]);

  const onForm = step === 'form' && selection;
  const fromRestaurantPage =
    !!initial && !!selection && selectionKey(selection) === selectionKey(initial);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
      <header className="space-y-2">
        {fromRestaurantPage && onForm && initial.restaurantId && (
          <Link
            href={restaurantHref(initial.restaurantId)}
            className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-muted hover:text-ink"
          >
            ← 返回餐厅页面
          </Link>
        )}
        <p className="text-sm font-semibold text-chili-700">
          {onForm ? '第二步 · 填写点评' : '第一步 · 选择餐厅'}
        </p>
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-2xl leading-tight font-black outline-none sm:text-3xl"
        >
          {onForm ? `为「${selection.name}」投稿` : '投稿：分享你的用餐体验'}
        </h1>
        {onForm && (
          <button
            type="button"
            onClick={() => setStep('select')}
            className="text-sm font-semibold text-chili-700 underline"
          >
            更换餐厅
          </button>
        )}
      </header>

      {onForm ? (
        <SubmitForm formId={formId} context={toContext(selection, fromRestaurantPage)} />
      ) : (
        <RestaurantSelector
          selection={selection}
          startView={mapView}
          onSelect={setSelection}
          onNext={() => setStep('form')}
          onViewChange={setMapView}
        />
      )}
    </div>
  );
}

export function toContext(s: Selection, fromRestaurantPage: boolean): SubmissionContext {
  return {
    source: fromRestaurantPage ? 'restaurant-page' : 'site',
    selectionMethod: s.method,
    restaurantId: s.restaurantId,
    restaurantName: s.name,
    location: s.location,
    address: s.address,
    poiProvider: s.poi?.provider,
    poiId: s.poi?.id,
  };
}

/** Without a load event by then, the page offers the form in a new window. */
const FORM_LOAD_TIMEOUT_MS = 15000;

function SubmitForm({ formId, context }: { formId: string; context: SubmissionContext }) {
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), FORM_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);
  // Selections are complete by construction; this guards against regressions.
  if (contextProblem(context)) {
    return (
      <p role="status" className="text-sm text-chili-700">
        餐厅信息不完整，请点「更换餐厅」重新选择。
      </p>
    );
  }
  const urls = tallyUrls(formId, context);
  return (
    <section aria-label="投稿表单" className="space-y-3">
      {slow && !loaded && (
        // Only when the embed has not loaded (blocked, offline, or slow).
        <p role="status" className="text-sm">
          表单还没有加载出来？
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
      )}
      <iframe
        src={urls.embed}
        title="Rice吃啥 投稿表单"
        onLoad={() => setLoaded(true)}
        className="h-[75dvh] min-h-[560px] w-full rounded-2xl border border-line bg-white"
      />
    </section>
  );
}
