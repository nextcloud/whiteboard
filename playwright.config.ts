import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    trace: 'on-first-retry',
    baseURL: 'http://nextcloud.local/index.php/', // 'http://localhost:8089/index.php/',
  },

  projects: [
    { 
      name: 'setup',
      testMatch: /setup\.ts$/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
		// Starts the Nextcloud docker container
		command: 'npm run start:nextcloud',
		reuseExistingServer: true, // !process.env.CI,
		url: 'http://nextcloud.local/index.php/', // 'http://127.0.0.1:8089',
		stderr: 'pipe',
		stdout: 'pipe',
		timeout: 5 * 60 * 1000, // max. 5 minutes for creating the container
	},
});
