import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // await page.goto('https://demo.playwright.dev/todomvc');
});

test.describe('Example', () => {
  test('show the title', async ({ page }) => {
    await page.goto('https://example.com')
    await expect(page).toHaveTitle(/Example Domain/)
  })
})
