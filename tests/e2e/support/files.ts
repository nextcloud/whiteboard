import { expect, type Locator, type Page } from '@playwright/test'

export class FilesApp {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    async goto() {
        await this.page.goto('http://nextcloud.local/index.php/apps/files')
    }

    async newFile(name: string) {
        await this.page.getByRole('button', { name: 'New' }).click()
        const newButton = await this.page.getByRole('menuitem', { name: 'New whiteboard' })
        await newButton.scrollIntoViewIfNeeded()
        await newButton.click()

        await this.page.getByPlaceholder('Filename', { exact: true }).fill(name)
        await this.page.getByRole('button', { name: 'Create' }).click()
    }

}