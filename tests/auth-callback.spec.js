// @ts-check
import { test, expect } from '@playwright/test';

// Tests for `auth-callback.html` — the HealthBite signup-confirmation bridge.
// See docs/adr/001-email-confirmation-pc-fallback.md (in the HealthBite repo)
// for the design these tests pin down.

const APP_STORE_URL = 'https://apps.apple.com/app/healthbite/id6738970819';

const UA = {
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
};

// The page auto-fires `healix://...` on load. Chromium logs a console error
// when no handler is registered for a custom-scheme navigation. That's
// expected and not a test failure — silence it so it doesn't get mistaken
// for a real regression.
function ignoreCustomSchemeNoise(page) {
  page.on('pageerror', () => { /* allow */ });
}

test.describe('Desktop user opens confirmation email', () => {
  test.use({ userAgent: UA.desktop });

  test('after 2s, fallback is visible with correct App Store URL and no auth API calls', async ({ page }) => {
    ignoreCustomSchemeNoise(page);

    // Spy on every request — assert the page never tries to exchange the
    // PKCE code or otherwise call the Supabase auth endpoint.
    const authCalls = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/auth/v1/') || url.includes('supabase')) {
        authCalls.push(url);
      }
    });

    await page.goto('/auth-callback.html?code=test-pkce-code');

    // Fallback only renders after 2s, so wait for it.
    await expect(page.locator('[data-test="fallback"]')).toBeVisible({ timeout: 4_000 });
    await expect(page.locator('[data-test="opening"]')).toBeHidden();

    // App Store link points where we expect.
    await expect(page.locator('[data-test="app-store-link"]')).toHaveAttribute('href', APP_STORE_URL);

    // QR code element is present.
    await expect(page.locator('[data-test="qr-code"] img')).toBeVisible();

    // Mobile-only retry button stays hidden on desktop.
    await expect(page.locator('[data-test="retry-button"]')).toBeHidden();

    // Andriod note is present.
    await expect(page.locator('[data-test="android-note"]')).toContainText(/coming soon/i);

    // No Supabase / auth calls were made — we deliberately don't exchange the code.
    expect(authCalls).toEqual([]);
  });
});

test.describe('iPhone user falls through to fallback (e.g. in-app browser)', () => {
  test.use({ userAgent: UA.iphone });

  test('retry button is visible and re-fires the deep link with the URL code', async ({ page }) => {
    ignoreCustomSchemeNoise(page);

    await page.goto('/auth-callback.html?code=iphone-code-xyz');

    await expect(page.locator('[data-test="fallback"]')).toBeVisible({ timeout: 4_000 });

    const retry = page.locator('[data-test="retry-button"]');
    await expect(retry).toBeVisible();
    await expect(retry).toHaveAttribute('href', /^healix:\/\/auth-callback/);
    await expect(retry).toHaveAttribute('href', /code=iphone-code-xyz/);
  });
});

test.describe('Android user', () => {
  test.use({ userAgent: UA.android });

  test('sees "coming soon" copy and no Play Store link', async ({ page }) => {
    ignoreCustomSchemeNoise(page);

    await page.goto('/auth-callback.html?code=any');

    await expect(page.locator('[data-test="fallback"]')).toBeVisible({ timeout: 4_000 });
    await expect(page.locator('[data-test="android-note"]')).toContainText(/coming soon/i);

    // No Play Store link anywhere on the page.
    await expect(page.locator('a[href*="play.google.com"]')).toHaveCount(0);
  });
});

test.describe('Edge cases', () => {
  test('no ?code= in URL: page renders fallback without throwing', async ({ page }) => {
    ignoreCustomSchemeNoise(page);

    const jsErrors = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/auth-callback.html');

    await expect(page.locator('[data-test="fallback"]')).toBeVisible({ timeout: 4_000 });
    expect(jsErrors).toEqual([]);
  });

  test('branding: HealthBite logo present, no "Healix" wordmark in card copy', async ({ page }) => {
    ignoreCustomSchemeNoise(page);

    await page.goto('/auth-callback.html?code=brand-check');

    await expect(page.locator('[data-test="healthbite-logo"]')).toBeVisible();
    await expect(page.locator('[data-test="fallback"]')).toBeVisible({ timeout: 4_000 });

    // The card itself (the user-facing copy block) must not say "Healix".
    // The page chrome (nav) is HealthBite-branded too, but we scope this
    // assertion to the card to leave room for the existing global theme to
    // evolve without breaking this test.
    const cardText = await page.locator('.card').textContent();
    expect(cardText.toLowerCase()).not.toContain('healix');
  });
});
