import { expect, test, type Page } from '@playwright/test';

// Fixture data (fixtures/restaurants): 11 published restaurants, 10 with coordinates, 1 draft.
const PUBLISHED = 11;
const WITH_LOCATION = 10;

test.beforeEach(async ({ page }) => {
  // Keep tests offline and avoid loading real map tiles.
  await page.route(/tile\.openstreetmap\.org/, (route) => route.abort());
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
