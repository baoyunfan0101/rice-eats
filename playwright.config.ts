import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against a fixture build (npm run build:e2e) served like GitHub Pages.
// They use the locally installed Google Chrome, so no browser download is needed.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' } },
  ],
  webServer: {
    command: 'tsx tests/e2e/static-server.ts dist-e2e 4173',
    url: 'http://localhost:4173/rice-eats/',
    reuseExistingServer: !process.env.CI,
  },
});
