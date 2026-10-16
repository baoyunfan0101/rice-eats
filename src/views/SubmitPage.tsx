import { useEffect, useRef, useState } from 'react';
import { KeywordInput } from '../components/KeywordInput';
import { Link } from '../components/Link';
import { StepIndicator } from '../components/StepIndicator';
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
 * (selecting and checking it happen in place), 第二步 add optional keywords,
 * then fill in the embedded Tally form (loaded only here, after the keywords
 * are confirmed). Arriving from a restaurant page starts at step 2 with that
 * restaurant, and "更换餐厅" goes back to step 1. The chosen restaurant and
 * the keywords reach the form as hidden fields.
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
          <Link href={browseHref()} className="btn btn-primary">
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

/** The two steps, as the step indicator names them. */
const STEPS = [{ label: '选择餐厅' }, { label: '填写点评' }];

function SubmitFlow({ formId, initial }: { formId: string; initial?: Selection }) {
  const [step, setStep] = useState<Step>(initial ? 'form' : 'select');
  const [selection, setSelection] = useState<Selection | undefined>(initial);
  // Where the map was, so going back to step 1 keeps the contributor's place.
  const [mapView, setMapView] = useState<MapView>();
  const [searchArea, setSearchArea] = useState<SearchArea>();
  // Keywords belong to one restaurant: choosing another starts over.
  const [keywords, setKeywords] = useState<{ key: string; list: string[]; confirmed: boolean }>({
    key: '',
    list: [],
    confirmed: false,
  });
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
  // Keywords belong to one restaurant; manual entries all share one selection
  // key, so their name tells them apart.
  const currentKey = selection
    ? `${selectionKey(selection)}${selection.method === 'manual' ? `:${selection.name}` : ''}`
    : '';
  const fresh = { key: currentKey, list: [] as string[], confirmed: false };
  const words = keywords.key === currentKey ? keywords : fresh;
  const setWords = (next: Partial<typeof words>) =>
    setKeywords((prev) => ({ ...(prev.key === currentKey ? prev : fresh), ...next }));
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
      <header className="space-y-4">
        {fromRestaurantPage && onForm && initial.restaurantId && (
          <Link
            href={restaurantHref(initial.restaurantId)}
            className="inline-flex min-h-10 items-center gap-1 text-sm font-bold text-muted hover:text-chili-700"
          >
            ← 返回餐厅页面
          </Link>
        )}
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl leading-tight font-black outline-none sm:text-3xl"
          >
            {onForm ? `为「${selection.name}」投稿` : '投稿：分享你的用餐体验'}
          </h1>
          {onForm && (
            <button type="button" onClick={() => setStep('select')} className="btn btn-sm">
              更换餐厅
            </button>
          )}
        </div>
        <div className="card px-3 py-2.5 sm:px-4 sm:py-3">
          <StepIndicator steps={STEPS} current={onForm ? 1 : 0} onBack={() => setStep('select')} />
        </div>
      </header>

      {onForm ? (
        <>
          <KeywordStep
            keywords={words.list}
            confirmed={words.confirmed}
            onChange={(list) => setWords({ list })}
            onConfirm={() => setWords({ confirmed: true })}
            onEdit={() => setWords({ confirmed: false })}
          />
          {words.confirmed && (
            <SubmitForm
              // A new restaurant or new keywords start a fresh form (and load check);
              // keywords only change after the contributor confirms that.
              key={`${currentKey}\0${words.list.join('\0')}`}
              formId={formId}
              context={{ ...toContext(selection, fromRestaurantPage), keywords: words.list }}
            />
          )}
        </>
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

/**
 * Optional keywords, before the form: the form receives them as a hidden
 * field when it loads, so they are confirmed first. Changing them afterwards
 * reloads the form, which clears what was typed in it, so that needs a
 * confirmation.
 */
function KeywordStep({
  keywords,
  confirmed,
  onChange,
  onConfirm,
  onEdit,
}: {
  keywords: string[];
  confirmed: boolean;
  onChange: (keywords: string[]) => void;
  onConfirm: () => void;
  onEdit: () => void;
}) {
  const [asking, setAsking] = useState(false);
  // The button that confirmed goes away; keep the focus in place on the summary.
  const moveFocus = useRef(false);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    if (confirmed && moveFocus.current) summary.current?.focus();
    moveFocus.current = false;
  }, [confirmed]);
  if (confirmed) {
    return (
      <section
        ref={summary}
        tabIndex={-1}
        aria-label="关键词"
        className="card space-y-2 px-3 py-2.5 outline-none focus-visible:ring-2 sm:px-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            <span className="font-black">关键词：</span>
            {keywords.length ? keywords.join('、') : <span className="text-muted">未添加</span>}
          </p>
          {!asking && (
            <button type="button" onClick={() => setAsking(true)} className="btn btn-sm">
              修改关键词
            </button>
          )}
        </div>
        {asking && (
          <div
            role="alert"
            className="space-y-2 border-t-2 border-dashed border-ink/30 pt-2 text-sm"
          >
            <p>修改关键词后，下方表单会重新加载，表单里已经填写的内容会被清空。</p>
            <p className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setAsking(false);
                  onEdit();
                }}
                className="btn btn-sm btn-primary"
              >
                确认修改
              </button>
              <button type="button" onClick={() => setAsking(false)} className="btn btn-sm">
                取消
              </button>
            </p>
          </div>
        )}
      </section>
    );
  }
  return (
    <section aria-label="关键词" className="card space-y-3 p-4">
      <KeywordInput
        value={keywords}
        onChange={onChange}
        label="用几个关键词描述这家店（选填）"
        hint="比如：适合约会、很安静、份量大。输入后按回车添加，可以添加多个。"
      />
      <button
        type="button"
        onClick={() => {
          moveFocus.current = true;
          onConfirm();
        }}
        className="btn btn-primary"
      >
        {keywords.length ? '下一步：填写点评表单 →' : '跳过，填写点评表单 →'}
      </button>
    </section>
  );
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
      <p role="status" className="text-sm font-semibold text-chili-700">
        餐厅信息不完整，请点「更换餐厅」重新选择。
      </p>
    );
  }
  const urls = tallyUrls(formId, context);
  return (
    <section aria-label="投稿表单" className="space-y-3">
      <div role="status" className="text-sm empty:hidden">
        {state === 'loading' && (
          <p className="flex items-center gap-2 font-semibold text-muted">
            <span aria-hidden="true" className="pixel-loader" />
            正在加载投稿表单…
          </p>
        )}
        {state === 'stalled' && (
          <div className="card space-y-3 bg-chili-50 p-4">
            <p>表单好像没有正常加载，可能是网络问题，或表单服务暂时不可用。</p>
            <p className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                onClick={() => {
                  setState('loading');
                  setAttempt((n) => n + 1);
                }}
                className="btn btn-primary"
              >
                重新加载表单
              </button>
              <a
                href={urls.direct}
                target="_blank"
                rel="noopener noreferrer"
                className="text-action"
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
        className="h-[75dvh] min-h-[560px] w-full border-2 border-ink bg-white shadow-px"
      />
    </section>
  );
}
