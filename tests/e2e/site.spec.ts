import { expect, test, type Page } from '@playwright/test';

// Fixture data (fixtures/restaurants): 11 published restaurants, 10 with coordinates, 1 draft.
const PUBLISHED = 11;
const WITH_LOCATION = 10;

test.beforeEach(async ({ page }) => {
  // Keep tests offline and avoid loading real map tiles.
  await page.route(/tile\.openstreetmap\.org/, (route) => route.abort());
  // The fixture build points at a fake Tally form (TALLY_FORM in build:e2e);
  // a stub page stands in for it, so no test depends on a real Tally account.
  await page.route(/^https:\/\/tally\.so\//, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>stub</title><p>Stub Tally form</p><p id="query">${new URL(route.request().url()).search}</p>`,
    }),
  );
});

const listNames = (page: Page) =>
  page.getByRole('list', { name: '餐厅列表' }).getByRole('heading', { level: 2 }).allTextContents();

test('list, grid, and map share filters and the URL', async ({ page }) => {
  await page.goto('/rice-eats/');
  await expect(page.getByText(`共 ${PUBLISHED} 家`)).toBeVisible();
  await expect(page.getByText('虚构的示例数据')).toBeVisible();
  expect(await listNames(page)).not.toContain('草稿餐厅（虚构示例）');

  await page.getByLabel('按菜系筛选').selectOption('chinese');
  await expect(page).toHaveURL(/cuisine=chinese/);
  expect(await listNames(page)).toEqual(['蜀味小馆（虚构示例）', '点心大堂（虚构示例）']);

  await page.getByRole('button', { name: '网格' }).click();
  const grid = page.getByRole('list', { name: '餐厅网格' });
  await expect(grid.getByRole('link')).toHaveCount(2);

  await page.getByRole('button', { name: '地图' }).click();
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(2);
  await expect(page).toHaveURL(/view=map/);

  await page.reload();
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(2);
  await expect(page.getByText('找到 2 家 / 共 11 家')).toBeVisible();

  await page.goBack();
  await expect(grid.getByRole('link')).toHaveCount(2);
});

test('map shows located restaurants and opens details from a marker', async ({ page }) => {
  await page.goto('/rice-eats/?view=map');
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(WITH_LOCATION);
  await expect(page.getByText('1 家餐厅暂无位置信息')).toBeVisible();
  await expect(page.getByText('部分地图底图加载失败')).toBeVisible();
  await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');

  // The marker (the sidebar list is hidden on small screens). Nearby markers
  // overlap at this zoom, so select it with the keyboard (Enter), as a screen
  // reader or keyboard user would.
  const marker = page.getByRole('button', { name: '灯笼拉面（虚构示例）', exact: true });
  await marker.focus();
  await marker.press('Enter');
  await expect(page).toHaveURL(/id=fixture-lantern-noodles/);
  const preview = page.getByRole('region', { name: '灯笼拉面（虚构示例） 预览' });
  await expect(preview).toBeVisible();
  await preview.getByRole('link', { name: '查看详情' }).click();
  await expect(page).toHaveURL(/\/rice-eats\/r\/fixture-lantern-noodles\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('灯笼拉面（虚构示例）');
});

test('restaurant pages render rich content and survive reloads', async ({ page }) => {
  const response = await page.goto('/rice-eats/r/fixture-dim-sum-hall/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('点心大堂（虚构示例）');
  const review = page.getByRole('region', { name: '点评' });
  await expect(review.locator('figure img')).toHaveCount(3);
  await expect(review.locator('figcaption').first()).toHaveText('虾饺（示例图注）');
  await expect(review.getByRole('heading', { level: 2, name: '早茶时间' })).toBeVisible();

  // Every image on the page loads from the /rice-eats/ base path.
  const images = page.locator('img');
  for (const src of await images.evaluateAll((els) =>
    els.map((el) => (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src),
  )) {
    expect(new URL(src).pathname).toMatch(/^\/rice-eats\//);
  }
  await review.locator('figure img').last().scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      review
        .locator('figure img')
        .last()
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  await page.getByRole('link', { name: '← 全部餐厅' }).click();
  await expect(page).toHaveURL(/\/rice-eats\/$/);
});

test('photo-only restaurants show their photos; same-name restaurants stay separate', async ({
  page,
}) => {
  await page.goto('/rice-eats/r/fixture-photo-only/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('只有照片的小店（虚构示例）');
  await expect(
    page.getByRole('img', { name: '只有照片的小店（虚构示例）', exact: true }),
  ).toBeVisible(); // cover
  await expect(page.getByRole('region', { name: '照片' }).getByRole('img')).toHaveCount(2);
  await expect(page.getByRole('link', { name: /Google 地图导航/ })).toHaveAttribute(
    'href',
    /google\.com\/maps/,
  );
  await expect(page.getByRole('link', { name: /Apple 地图导航/ })).toHaveAttribute(
    'href',
    /maps\.apple\.com/,
  );

  await page.goto('/rice-eats/?q=街角塔可');
  await expect(page.getByText('找到 2 家 / 共 11 家')).toBeVisible();
  const links = page.getByRole('list', { name: '餐厅列表' }).getByRole('link');
  const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(new Set(hrefs).size).toBe(2);
});

test('unknown pages and drafts are not found', async ({ page }) => {
  const draft = await page.goto('/rice-eats/r/fixture-draft-only/');
  expect(draft?.status()).toBe(404);
  await expect(page.getByText('找不到这家餐厅')).toBeVisible();
  const missing = await page.goto('/rice-eats/nowhere');
  expect(missing?.status()).toBe(404);
  await expect(page.getByText('页面不存在')).toBeVisible();
  expect(
    (await page.request.get('/rice-eats/generated/restaurants/fixture-draft-only.json')).status(),
  ).toBe(404);
});

test('layout fits the viewport without horizontal scrolling', async ({ page }) => {
  for (const url of [
    '/rice-eats/',
    '/rice-eats/?view=grid',
    '/rice-eats/?view=map',
    '/rice-eats/r/fixture-sichuan-house/',
    '/rice-eats/submit/',
  ]) {
    await page.goto(url);
    await expect(page.getByRole('main')).not.toBeEmpty();
    await page.waitForLoadState('networkidle');
    // Compare with the device viewport: on phones, content wider than the screen
    // also widens window.innerWidth (the page gets zoomed out), hiding overflow.
    const width = page.viewportSize()!.width;
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth, url).toBeLessThanOrEqual(width);
  }
});

test('keyboard users can reach search, views, and restaurants', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'keyboard navigation is a desktop concern');
  await page.goto('/rice-eats/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await page.getByRole('searchbox').focus();
  await page.keyboard.type('河粉');
  expect(await listNames(page)).toEqual(['河粉花园（虚构示例）']);
  await page.getByRole('link', { name: /河粉花园/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('河粉花园（虚构示例）');
});

/** A fake Geoapify Places API: one restaurant near the search center (or named after the query). */
async function fakePlaces(page: Page) {
  const requests: URL[] = [];
  await page.route(/^https:\/\/api\.geoapify\.com\//, (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const [lng, lat] = url.searchParams
      .get('filter')!
      .replace('circle:', '')
      .split(',')
      .map(Number);
    const name = url.searchParams.get('name');
    return route.fulfill({
      json: {
        features: [
          {
            properties: {
              place_id: 'e2e-place',
              name: name ? `${name} Kitchen` : 'Fake Noodle Bar',
              address_line2: '1 Fake St',
              lat: lat! + 0.001,
              lon: lng!,
            },
          },
        ],
      },
    });
  });
  return requests;
}

const formQuery = (page: Page) =>
  page.frameLocator('iframe[title="Rice吃啥 投稿表单"]').locator('#query');

test('visitors choose a restaurant near their location before the form loads', async ({
  page,
  context,
}) => {
  const places = await fakePlaces(page);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 29.7174, longitude: -95.4018 });
  const response = await page.goto('/rice-eats/submit/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('投稿：分享你的用餐体验');
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(places).toEqual([]); // nothing is searched before a deliberate action

  await page.getByRole('button', { name: '使用当前位置' }).click();
  const list = page.getByRole('list', { name: '附近的餐厅' });
  await list.getByRole('button', { name: /Fake Noodle Bar/ }).click();
  expect(places[0]!.searchParams.get('filter')).toBe('circle:-95.401800,29.717400,300');
  expect(places[0]!.searchParams.get('categories')).toContain('catering.restaurant');

  await expect(page.getByRole('heading', { name: '确认餐厅' })).toBeVisible();
  await page.getByRole('button', { name: '确认餐厅' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('为「Fake Noodle Bar」投稿');
  const query = formQuery(page);
  await expect(query).toContainText('restaurant_name=Fake+Noodle+Bar');
  await expect(query).toContainText('restaurant_lat=29.718400&restaurant_lng=-95.401800');
  await expect(query).toContainText('poi_provider=geoapify&poi_id=e2e-place');
  await expect(query).toContainText('selection_method=poi&source=site');
  // The device position itself is never submitted.
  await expect(query).not.toContainText('29.717400');
});

test('visitors without location permission can tap the map or search by name', async ({ page }) => {
  const places = await fakePlaces(page);
  await page.goto('/rice-eats/submit/');
  await page.getByRole('button', { name: '使用当前位置' }).click();
  await expect(page.getByText(/没有获得定位权限|暂时无法获取当前位置/)).toBeVisible();

  await page
    .getByRole('region', { name: '选择餐厅位置的地图' })
    .click({ position: { x: 120, y: 90 } });
  await expect(page.getByRole('list', { name: '附近的餐厅' })).toBeVisible();
  expect(places[0]!.searchParams.get('filter')).toMatch(/^circle:-95\.\d+,29\.\d+,300$/);
  await page.getByRole('button', { name: /扩大搜索范围到 1\.0 公里/ }).click();
  await expect.poll(() => places.at(-1)!.searchParams.get('filter')).toMatch(/,1000$/);

  await page.getByRole('searchbox', { name: '按名字搜索' }).fill('Dumpling');
  await page
    .getByRole('list', { name: '附近的餐厅' })
    .getByRole('button', { name: /Dumpling Kitchen/ })
    .click();
  await page.getByRole('button', { name: '重新选择' }).click();
  await expect(page.getByRole('heading', { name: '第一步：选择餐厅' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('visitors can add a restaurant by hand when search fails', async ({ page }) => {
  await page.route(/^https:\/\/api\.geoapify\.com\//, (route) =>
    route.fulfill({ status: 429, body: '' }),
  );
  await page.goto('/rice-eats/submit/');
  await page.getByRole('button', { name: '搜索地图中心附近' }).click();
  await expect(page.getByText(/餐厅搜索暂时不可用/)).toBeVisible();

  await page.getByRole('button', { name: '手动添加餐厅' }).click();
  await page.getByLabel('餐厅名字').fill('新开的面馆');
  await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();
  await page
    .getByRole('region', { name: '标出餐厅位置的地图' })
    .click({ position: { x: 150, y: 100 } });
  await expect(page.getByText('已标出位置，可以再点一下修改。')).toBeVisible();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '确认餐厅' }).click();
  const query = formQuery(page);
  await expect(query).toContainText(
    'restaurant_name=%E6%96%B0%E5%BC%80%E7%9A%84%E9%9D%A2%E9%A6%86',
  );
  await expect(query).toContainText('restaurant_lat=29.');
  await expect(query).toContainText('selection_method=manual');
  await expect(query).not.toContainText('poi_id');

  // Name only: allowed, and marked for location checking.
  await page.getByRole('button', { name: '更换餐厅' }).click();
  await page.getByRole('button', { name: '手动添加餐厅' }).click();
  await page.getByLabel('餐厅名字').fill('Mystery Diner');
  await page.getByLabel(/我不确定具体位置/).check();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText(/没有位置信息/)).toBeVisible();
  await page.getByRole('button', { name: '确认餐厅' }).click();
  await expect(query).toContainText(
    'restaurant_name=Mystery+Diner&selection_method=manual&source=site',
  );
});

test('a restaurant page passes its restaurant to the form', async ({ page }) => {
  await page.goto('/rice-eats/r/fixture-sichuan-house/');
  await page.getByRole('link', { name: '补充点评或照片' }).click();
  await expect(page).toHaveURL(/\/rice-eats\/submit\/\?restaurant=fixture-sichuan-house$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    '为「蜀味小馆（虚构示例）」投稿',
  );
  const query = formQuery(page);
  await expect(
    page.frameLocator('iframe[title="Rice吃啥 投稿表单"]').getByText('Stub Tally form'),
  ).toBeVisible();
  await expect(query).toContainText('restaurant_id=fixture-sichuan-house');
  await expect(query).toContainText('restaurant_lat=29.705300&restaurant_lng=-95.546500');
  await expect(query).toContainText('selection_method=existing&source=restaurant-page');
  await expect(page.getByRole('link', { name: /在新窗口打开投稿表单/ })).toHaveAttribute(
    'href',
    /^https:\/\/tally\.so\/r\/e2eForm\?restaurant_id=fixture-sichuan-house&/,
  );

  await page.getByRole('button', { name: '更换餐厅' }).click();
  await expect(page.getByRole('heading', { name: '第一步：选择餐厅' })).toBeVisible();
  await page.getByRole('link', { name: '投稿', exact: true }).click();
  await expect(page).toHaveURL(/\/rice-eats\/submit\/$/);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('the form does not load on other pages', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tally.so')) requests.push(request.url());
  });
  await page.goto('/rice-eats/');
  await expect(page.getByText(`共 ${PUBLISHED} 家`)).toBeVisible();
  await page.goto('/rice-eats/r/fixture-dim-sum-hall/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(requests).toEqual([]);
});

test('keyboard users can reach the submission entry and fallback link', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'keyboard navigation is a desktop concern');
  await page.goto('/rice-eats/');
  await expect(page.getByText(`共 ${PUBLISHED} 家`)).toBeVisible();
  const entry = page.getByRole('link', { name: '投稿', exact: true });
  for (let i = 0; i < 5 && !(await entry.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(entry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/rice-eats\/submit\/$/);
  const locate = page.getByRole('button', { name: '使用当前位置' });
  for (let i = 0; i < 10 && !(await locate.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(locate).toBeFocused();

  await page.goto('/rice-eats/submit/?restaurant=fixture-sichuan-house');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    '为「蜀味小馆（虚构示例）」投稿',
  );
  const fallback = page.getByRole('link', { name: /在新窗口打开投稿表单/ });
  for (
    let i = 0;
    i < 10 && !(await fallback.evaluate((el) => el === document.activeElement));
    i++
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(fallback).toBeFocused();
});
