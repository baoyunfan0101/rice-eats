import { useEffect, useRef, useState } from 'react';
import { Link } from '../components/Link';
import type { SearchArea } from '../lib/areas';
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
    document.title = '投稿 · Rice Eats';
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
  const [searchArea, setSearchArea] = useState<SearchArea>();
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
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-2xl leading-tight font-black outline-none sm:text-3xl"
        >
          {onForm ? `为「${selection.name}」投稿` : '投稿：分享你的用餐体验'}
        </h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm font-semibold text-chili-700">
            {onForm ? '第二步 · 填写点评' : '第一步 · 选择餐厅'}
          </p>
          {onForm && (
            <button
              type="button"
              onClick={() => setStep('select')}
              className="text-sm font-semibold text-muted underline hover:text-ink"
            >
              更换餐厅
            </button>
          )}
        </div>
      </header>

      {onForm ? (
        <SubmitForm
          // A new restaurant starts a fresh form (and load check).
          key={selectionKey(selection)}
          formId={formId}
          context={toContext(selection, fromRestaurantPage)}
        />
      ) : (
        <RestaurantSelector
          selection={selection}
          startView={mapView}
          startArea={searchArea}
          onSelect={setSelection}
          onNext={() => setStep('form')}
          onViewChange={setMapView}
          onAreaChange={setSearchArea}
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

/** Origin of the embedded form; only its messages are trusted. */
const TALLY_ORIGIN = 'https://tally.so';
/** Without Tally's "form loaded" message by then, the page offers recovery. */
export const FORM_LOAD_TIMEOUT_MS = 10000;

/**
 * Whether a message is Tally's own "form loaded" event for this form. Tally's
 * embedded forms post `Tally.FormLoaded` to the parent once the form has
 * rendered (an error page, e.g. an unknown or closed form, does not), so it
 * is a better signal than the iframe's load event.
 */
export function isFormLoaded(data: unknown, formId: string): boolean {
  let message = data;
  if (typeof message === 'string') {
    try {
      message = JSON.parse(message) as unknown;
    } catch {
      return false;
    }
  }
  if (typeof message !== 'object' || message === null) return false;
  const { event, payload } = message as { event?: unknown; payload?: { formId?: unknown } };
  return event === 'Tally.FormLoaded' && payload?.formId === formId;
}

type FormState = 'loading' | 'ready' | 'stalled';

/**
 * The embedded form. It counts as shown once Tally reports the form loaded;
 * until then a short loading note is shown, and if that has not happened
 * after FORM_LOAD_TIMEOUT_MS (blocked, offline, Tally down, or an error page
 * inside the frame), the page says so and offers to reload the form or open
 * it in a new window, with the same restaurant.
 */
function SubmitForm({ formId, context }: { formId: string; context: SubmissionContext }) {
  const [state, setState] = useState<FormState>('loading');
  /** Bumped by "重新加载" to recreate the iframe. */
  const [attempt, setAttempt] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const timer = setTimeout(
      () => setState((s) => (s === 'loading' ? 'stalled' : s)),
      FORM_LOAD_TIMEOUT_MS,
    );
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== TALLY_ORIGIN || e.source !== frame.current?.contentWindow) return;
      if (isFormLoaded(e.data, formId)) setState('ready');
    };
    window.addEventListener('message', onMessage);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
  }, [formId, attempt]);

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
      <div role="status" className="text-sm empty:hidden">
        {state === 'loading' && <p className="text-muted">正在加载投稿表单…</p>}
        {state === 'stalled' && (
          <div className="space-y-2 rounded-2xl border border-chili-600 bg-chili-50 p-4">
            <p>表单好像没有正常加载，可能是网络问题，或表单服务暂时不可用。</p>
            <p className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                onClick={() => {
                  setState('loading');
                  setAttempt((n) => n + 1);
                }}
                className="inline-flex min-h-10 items-center rounded-full bg-chili-600 px-4 font-semibold text-white hover:bg-chili-700"
              >
                重新加载表单
              </button>
              <a
                href={urls.direct}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-chili-700 underline"
              >
                在新窗口打开投稿表单
                <span className="sr-only">（在新窗口打开）</span>
              </a>
            </p>
          </div>
        )}
      </div>
      <iframe
        key={attempt}
        ref={frame}
        src={urls.embed}
        title="Rice Eats 投稿表单"
        className="h-[75dvh] min-h-[560px] w-full rounded-2xl border border-line bg-white"
      />
    </section>
  );
}
