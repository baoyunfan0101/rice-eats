import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ContentIndex } from '../../shared/content/model';
import { RATINGS } from '../../shared/content/vocabulary';
import { Toolbar } from '../components/Toolbar';
import { Button, ErrorState, Loading, Message } from '../components/States';
import { useContentIndex } from '../lib/content';
import {
  clearFilters,
  facetValues,
  filterRestaurants,
  parseBrowseState,
  toSearchParams,
  type BrowseState,
} from '../lib/filters';
import { browseHref, navigate } from '../lib/router';
import { GridView } from './GridView';
import { ListView } from './ListView';

// Leaflet is only downloaded when the map is opened.
const MapView = lazy(() => import('./MapView'));

export function BrowsePage({ params }: { params: URLSearchParams }) {
  const [attempt, setAttempt] = useState(0);
  const content = useContentIndex(attempt);

  useEffect(() => {
    document.title = 'Rice吃啥 · 莱斯大学周边美食指南';
  }, []);

  if (content.status === 'loading') return <Loading />;
  if (content.status === 'error') return <ErrorState onRetry={() => setAttempt((n) => n + 1)} />;
  return <Browse index={content.data} params={params} />;
}

function Browse({ index, params }: { index: ContentIndex; params: URLSearchParams }) {
  const state = parseBrowseState(params);
  const all = index.restaurants;
  const results = useMemo(() => filterRestaurants(all, state), [all, state]);
  const cuisines = useMemo(() => facetValues(all, (r) => r.cuisines), [all]);
  const tags = useMemo(() => facetValues(all, (r) => r.tags), [all]);
  const ratings = useMemo(
    () => RATINGS.filter((rating) => all.some((r) => r.rating === rating)),
    [all],
  );

  const update = (next: Partial<BrowseState>, options: { replace?: boolean } = {}) =>
    navigate(browseHref(toSearchParams({ ...state, ...next })), options);

  return (
    <>
      <SourceNotice index={index} />
      {all.length === 0 ? (
        <Message title="餐厅点评正在准备中">
          第一批餐厅点评还在整理，很快就会上线。欢迎之后再来看看！
        </Message>
      ) : (
        <>
          <Toolbar
            state={state}
            total={all.length}
            count={results.length}
            cuisines={cuisines}
            tags={tags}
            ratings={ratings}
            onChange={update}
          />
          {results.length === 0 ? (
            <Message
              icon="🔍"
              title="没有符合条件的餐厅"
              action={<Button onClick={() => update(clearFilters(state))}>清除筛选</Button>}
            >
              换个关键词，或者放宽筛选条件试试。
            </Message>
          ) : state.view === 'map' ? (
            <Suspense fallback={<Loading label="地图加载中…" />}>
              <MapView
                restaurants={results}
                selected={state.selected}
                onSelect={(id) => update({ selected: id }, { replace: true })}
              />
            </Suspense>
          ) : state.view === 'grid' ? (
            <GridView restaurants={results} />
          ) : (
            <ListView restaurants={results} />
          )}
        </>
      )}
    </>
  );
}

function SourceNotice({ index }: { index: ContentIndex }) {
  if (index.source !== 'fixtures' && !index.includesDrafts) return null;
  return (
    <div
      role="note"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900"
    >
      {index.source === 'fixtures'
        ? '开发预览：当前显示的是虚构的示例数据，不是真实的餐厅推荐。'
        : '草稿预览：当前包含未发布的草稿，仅供本地审阅。'}
    </div>
  );
}
