// @ts-check
import { defineConfig, devices } from '@playwright/test';

const PORT = 8181;

export default defineConfig({
  testDir: './tests',
  timeout: 15_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  // Single Chromium project — these tests are pure DOM/JS behaviour assertions
  // and don't need a browser matrix.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `http://localhost:${PORT}/auth-callback.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
