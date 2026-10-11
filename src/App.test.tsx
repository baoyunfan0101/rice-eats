// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { ContentIndex, RestaurantDetail, RestaurantSummary } from './content/model';
import { clearContentCache } from './lib/content';

const BASE = import.meta.env.BASE_URL;

const summary = (id: string, extra: Partial<RestaurantSummary> = {}): RestaurantSummary => ({
  id,
  status: 'published',
  name: id,
  altNames: [],
  cuisines: [],
  tags: [],
  ...extra,
});

const restaurants = [
  summary('Bayou BBQ', {
    cuisines: ['美式烧烤'],
    neighborhood: 'Montrose',
    rating: 5,
    pricePerPerson: 28,
    summary: '烟熏牛胸',
  }),
  summary('Pho Garden', {
    cuisines: ['越南菜'],
    neighborhood: 'Midtown',
    rating: 3,
    pricePerPerson: 14,
  }),
  summary('Food Truck', { cuisines: ['快餐'] }),
].map((r) => ({ ...r, id: r.name.toLowerCase().replace(' ', '-') }));

const detail: RestaurantDetail = {
  ...restaurants[0]!,
  address: '1 Example St',
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query=x',
  cover: { src: '/c.webp', srcset: '/c.webp 480w', width: 480, height: 320, alt: '封面' },
  dishes: [
    { name: '牛胸', verdict: '推荐', comment: '好吃' },
    { name: '豆子', verdict: '不推荐' },
  ],
  reviewHtml:
    '<h2>标题</h2><figure><img src="/a.webp" alt="图片说明"><figcaption>图注</figcaption></figure><p>正文</p>',
  contributors: [{ name: '作者甲' }],
};

let index: ContentIndex;
let failIndex = false;

beforeEach(() => {
  index = { source: 'content', includesDrafts: false, restaurants };
  failIndex = false;
  clearContentCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('generated/index.json')) {
        return failIndex ? new Response('', { status: 500 }) : Response.json(index);
      }
      if (url.endsWith(`generated/restaurants/${detail.id}.json`)) return Response.json(detail);
      return new Response('', { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function visit(path: string) {
  window.history.replaceState(null, '', `${BASE}${path}`);
  return render(<App />);
}

const names = (container: HTMLElement) =>
  within(container)
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent);

describe('browsing', () => {
  it('shows the list view with restaurant information', async () => {
    visit('');
    const list = await screen.findByRole('list', { name: '餐厅列表' });
    expect(names(list)).toEqual(['Bayou BBQ', 'Pho Garden', 'Food Truck']);
    expect(within(list).getByText('美式烧烤 · Montrose · 人均 $28')).toBeInTheDocument();
    expect(within(list).getByText('烟熏牛胸')).toBeInTheDocument();
    expect(screen.getByText('共 3 家')).toBeInTheDocument();
  });

  it('shares search and filters across views and keeps them in the URL', async () => {
    const user = userEvent.setup();
    visit('');
    await screen.findByRole('list', { name: '餐厅列表' });
    await user.selectOptions(screen.getByLabelText('按区域筛选'), 'Montrose');
    expect(window.location.search).toBe('?area=Montrose');
    expect(names(screen.getByRole('list', { name: '餐厅列表' }))).toEqual(['Bayou BBQ']);

    await user.click(screen.getByRole('button', { name: '网格' }));
    expect(window.location.search).toBe('?view=grid&area=Montrose');
    expect(names(screen.getByRole('list', { name: '餐厅网格' }))).toEqual(['Bayou BBQ']);
    expect(screen.getByText('找到 1 家 / 共 3 家')).toBeInTheDocument();

    act(() => window.history.back());
    expect(await screen.findByRole('list', { name: '餐厅列表' })).toBeInTheDocument();
  });

  it('restores state from a shared URL and handles no results', async () => {
    const user = userEvent.setup();
    visit('?view=grid&q=zzz');
    expect(await screen.findByText('没有符合条件的餐厅')).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('zzz');
    // Both the toolbar and the empty state offer "clear filters".
    expect(screen.getAllByRole('button', { name: '清除筛选' })).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: '清除筛选' })[1]!);
    expect(names(await screen.findByRole('list', { name: '餐厅网格' }))).toHaveLength(3);
  });

  it('searches by name', async () => {
    const user = userEvent.setup();
    visit('');
    await user.type(await screen.findByRole('searchbox'), 'pho');
    expect(names(screen.getByRole('list', { name: '餐厅列表' }))).toEqual(['Pho Garden']);
    expect(window.location.search).toBe('?q=pho');
  });

  it('shows a friendly empty state when nothing is published', async () => {
    index = { ...index, restaurants: [] };
    visit('');
    expect(await screen.findByText('餐厅点评正在准备中')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const user = userEvent.setup();
    failIndex = true;
    visit('');
    expect(await screen.findByText('内容加载失败')).toBeInTheDocument();
    failIndex = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('list', { name: '餐厅列表' })).toBeInTheDocument();
  });

  it('labels fixture data as fictional', async () => {
    index = { ...index, source: 'fixtures' };
    visit('');
    expect(await screen.findByText(/虚构的示例数据/)).toBeInTheDocument();
  });
});

describe('restaurant details', () => {
  it('opens from the list and renders text, images, and dishes', async () => {
    const user = userEvent.setup();
    visit('');
    await user.click(await screen.findByRole('link', { name: /Bayou BBQ/ }));
    expect(window.location.pathname).toBe(`${BASE}r/bayou-bbq/`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Bayou BBQ' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '封面' })).toHaveAttribute('srcset', '/c.webp 480w');
    expect(screen.getByRole('img', { name: '图片说明' })).toBeInTheDocument();
    expect(screen.getByText('图注')).toBeInTheDocument();
    expect(screen.getByText('👍 推荐')).toBeInTheDocument();
    expect(screen.getByText('踩雷提醒')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Google 地图/ })).toHaveAttribute(
      'href',
      detail.mapsUrl,
    );
    expect(screen.getByText(/作者甲/)).toBeInTheDocument();
    expect(document.title).toBe('Bayou BBQ · Rice吃啥');

    await user.click(screen.getByRole('button', { name: '← 返回' }));
    expect(await screen.findByRole('list', { name: '餐厅列表' })).toBeInTheDocument();
  });

  it('works as a direct link and offers a way back', async () => {
    visit('r/bayou-bbq');
    expect(await screen.findByRole('heading', { level: 1, name: 'Bayou BBQ' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← 全部餐厅' })).toHaveAttribute('href', BASE);
  });

  it('shows not-found pages for unknown restaurants and paths', async () => {
    const { unmount } = visit('r/missing');
    expect(await screen.findByText('找不到这家餐厅')).toBeInTheDocument();
    unmount();
    visit('some/other/path');
    expect(await screen.findByText('页面不存在')).toBeInTheDocument();
  });
});
