import { lazy, Suspense, useEffect, useRef, useState } from 'react';
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
import { RestaurantSelector } from './RestaurantSelector';
import type { Selection } from './submitTypes';

const PickerMap = lazy(() => import('./PickerMap'));

/**
 * The submission page, in three steps: choose a restaurant (or arrive from a
 * restaurant page, which skips this), confirm it, then fill in the embedded
 * Tally form (loaded only here, with a direct link as a fallback). The chosen
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

type Step =
  | { kind: 'select' }
  | { kind: 'confirm'; selection: Selection }
  | { kind: 'form'; selection: Selection };

function SubmitFlow({ formId, initial }: { formId: string; initial?: Selection }) {
  const [step, setStep] = useState<Step>(
    initial ? { kind: 'form', selection: initial } : { kind: 'select' },
  );
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
  }, [step.kind]);

  const name = step.kind === 'form' ? step.selection.name : undefined;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
      <header className="space-y-3">
        {initial?.restaurantId && step.kind === 'form' && step.selection === initial && (
          <Link
            href={restaurantHref(initial.restaurantId)}
            className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-muted hover:text-ink"
          >
            ← {initial.name}
          </Link>
        )}
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-2xl leading-tight font-black outline-none sm:text-3xl"
        >
          {name ? `为「${name}」投稿` : '投稿：分享你的用餐体验'}
        </h1>
      </header>

      {step.kind === 'select' && (
        <RestaurantSelector onSelected={(selection) => setStep({ kind: 'confirm', selection })} />
      )}
      {step.kind === 'confirm' && (
        <Confirm
          selection={step.selection}
          onConfirm={() => setStep({ kind: 'form', selection: step.selection })}
          onBack={() => setStep({ kind: 'select' })}
        />
      )}
      {step.kind === 'form' && (
        <SubmitForm
          formId={formId}
          selection={step.selection}
          fromRestaurantPage={step.selection === initial}
          onChange={() => setStep({ kind: 'select' })}
        />
      )}
    </div>
  );
}

function Confirm({
  selection: s,
  onConfirm,
  onBack,
}: {
  selection: Selection;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <section aria-labelledby="confirm-title" className="space-y-4">
      <h2 id="confirm-title" className="text-lg font-bold">
        确认餐厅
      </h2>
      <div className="space-y-1 rounded-2xl border border-line bg-white p-4">
        <p className="text-lg font-bold">{s.name}</p>
        {s.address && <p className="text-sm text-muted">{s.address}</p>}
        {!s.location && (
          <p className="text-sm text-chili-700">没有位置信息，审核时会再核实餐厅的位置。</p>
        )}
      </div>
      {s.location && (
        <Suspense fallback={<div className="h-56 rounded-2xl bg-line" />}>
          <PickerMap
            label="所选餐厅的位置"
            className="h-56"
            view={{ center: s.location, zoom: 17 }}
            marker={s.location}
          />
        </Suspense>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="inline-flex min-h-11 items-center rounded-full bg-chili-600 px-5 text-sm font-semibold text-white hover:bg-chili-700"
        >
          确认餐厅
        </button>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-11 items-center rounded-full border border-line bg-white px-5 text-sm font-semibold hover:border-chili-600"
        >
          重新选择
        </button>
      </div>
    </section>
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

function SubmitForm({
  formId,
  selection,
  fromRestaurantPage,
  onChange,
}: {
  formId: string;
  selection: Selection;
  fromRestaurantPage: boolean;
  onChange: () => void;
}) {
  const context = toContext(selection, fromRestaurantPage);
  // Selections are complete by construction; this guards against regressions.
  if (contextProblem(context)) {
    return (
      <p role="status" className="text-sm text-chili-700">
        餐厅信息不完整，请
        <button type="button" onClick={onChange} className="font-semibold underline">
          重新选择餐厅
        </button>
        。
      </p>
    );
  }
  const urls = tallyUrls(formId, context);
  return (
    <section aria-label="投稿表单" className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span>
          餐厅：<strong>{selection.name}</strong>
        </span>
        <button type="button" onClick={onChange} className="font-semibold text-chili-700 underline">
          更换餐厅
        </button>
      </div>
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
      <iframe
        src={urls.embed}
        title="Rice吃啥 投稿表单"
        className="h-[75dvh] min-h-[560px] w-full rounded-2xl border border-line bg-white"
      />
    </section>
  );
}
