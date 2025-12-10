/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface VotingOption {
	uuid: string
	type: 'answer'
	title: string
	votes: string[]
}

export interface Voting {
	uuid: string
	state: 'open' | 'closed'
	question: string
	author: string
	type: string
	options: VotingOption[]
	startedAt: number
}
