import { expect, type Locator, type Page } from '@playwright/test'

export class WhiteboardViewer {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    async isOpen(name: string) {
        await this.page.getByRole('heading', { name })
        await this.page.getByTitle('Hand (panning tool) — H').locator('div')
        await this.page.getByText('Drawing canvas')
    }

}