import { test as base, mergeTests} from '@playwright/test';
import { test as randomUser } from './fixtures/random-user';
import { FilesApp } from './support/files';
import { WhiteboardViewer } from './support/whiteboard';

export const test = randomUser

test.beforeEach(async ({ page }) => {
	await page.goto('apps/files')
	await page.waitForURL(/apps\/files$/)
})

test('New file', async ({ page }) => {
  await page.goto(`/apps/files`);

  await page.getByPlaceholder('Account name or email').fill('user1')
  await page.getByPlaceholder('Password').fill('user1')
  await page.getByRole('button', { name: 'Log in' }).click()

  await page.waitForURL('**/apps/files')
  await page.waitForSelector('h1')

  const filesApp = new FilesApp(page)
  await filesApp.newFile('Test file2.whiteboard')

  const whiteboardViewer = new WhiteboardViewer(page)
  await whiteboardViewer.isOpen('Test file2.whiteboard')
})