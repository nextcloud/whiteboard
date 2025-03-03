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

	// Cache for recently accessed whiteboards to reduce database reads
	private whiteboardCache = new Map<number, WhiteboardData>()
	private cacheExpiration = new Map<number, number>()
	private readonly CACHE_TTL = 60000 // Cache TTL: 1 minute

	constructor() {
		super('WhiteboardDatabase')

		// Define the schema for the database
		this.version(1).stores({
			whiteboards: '++id, savedAt',
		})
	}

	/**
	 * Check and clean expired cache entries
	 * @private
	 */
	private cleanCache() {
		const now = Date.now()
		for (const [id, expiration] of this.cacheExpiration.entries()) {
			if (now > expiration) {
				this.whiteboardCache.delete(id)
				this.cacheExpiration.delete(id)
			}
		}
	}

	/**
	 * Get whiteboard data by fileId
	 * @param fileId
	 */
	async getWhiteboardData(
		fileId: number,
	): Promise<WhiteboardData | undefined> {
		// Clean expired cache
		this.cleanCache()

		// Check cache first
		if (this.whiteboardCache.has(fileId)) {
			return this.whiteboardCache.get(fileId)
		}

		// Get from database if not in cache
		const data = await this.whiteboards.get(fileId)

		// Update cache
		if (data) {
			this.whiteboardCache.set(fileId, data)
			this.cacheExpiration.set(fileId, Date.now() + this.CACHE_TTL)
		}

		return data
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

		const data = {
			id: fileId,
			elements,
			files,
			savedAt: now,
		}

		// Update cache
		this.whiteboardCache.set(fileId, data)
		this.cacheExpiration.set(fileId, now + this.CACHE_TTL)

		// Save to database
		return this.whiteboards.put(data)
	}

	/**
	 * Delete whiteboard data from the database
	 * @param fileId
	 */
	async deleteWhiteboardData(fileId: number): Promise<void> {
		// Remove from cache
		this.whiteboardCache.delete(fileId)
		this.cacheExpiration.delete(fileId)

		// Delete from database
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
		// Clear cache
		this.whiteboardCache.clear()
		this.cacheExpiration.clear()

		// Clear database
		return this.whiteboards.clear()
	}

}

// Create a singleton instance of the database
export const db = new WhiteboardDatabase()
