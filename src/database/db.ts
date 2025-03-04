import Dexie from 'dexie'
import type { Table } from 'dexie'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types/types'

/**
 * Interface for whiteboard data stored in Dexie
 */
export interface WhiteboardData {
	id: number // fileId as the primary key
	elements: ExcalidrawElement[]
	files: BinaryFiles
	savedAt: number // timestamp of last save
}

/**
 * Dexie database class for whiteboard app
 */
export class WhiteboardDatabase extends Dexie {

	// Table definition
	whiteboards!: Table<WhiteboardData>

	constructor() {
		super('WhiteboardDatabase')

		// Define the schema for the database
		this.version(1).stores({
			whiteboards: '++id, savedAt',
		})
	}

	/**
	 * Get whiteboard data by fileId
	 * @param fileId
	 */
	async getWhiteboardData(
		fileId: number,
	): Promise<WhiteboardData | undefined> {
		return this.whiteboards.get(fileId)
	}

	/**
	 * Save whiteboard data to the database
	 * @param fileId
	 * @param elements
	 * @param files
	 */
	async saveWhiteboardData(
		fileId: number,
		elements: ExcalidrawElement[],
		files: BinaryFiles,
	): Promise<number> {
		const now = Date.now()

		return this.whiteboards.put({
			id: fileId,
			elements,
			files,
			savedAt: now,
		})
	}

	/**
	 * Delete whiteboard data from the database
	 * @param fileId
	 */
	async deleteWhiteboardData(fileId: number): Promise<void> {
		return this.whiteboards.delete(fileId)
	}

	/**
	 * List all whiteboard data
	 */
	async listWhiteboards(): Promise<WhiteboardData[]> {
		return this.whiteboards.toArray()
	}

	/**
	 * Get the count of stored whiteboards
	 */
	async getWhiteboardCount(): Promise<number> {
		return this.whiteboards.count()
	}

	/**
	 * Clear all data from the database
	 */
	async clearDatabase(): Promise<void> {
		return this.whiteboards.clear()
	}

}

// Create a singleton instance of the database
export const db = new WhiteboardDatabase()
