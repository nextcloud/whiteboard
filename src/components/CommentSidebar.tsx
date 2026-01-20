/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState, useRef, useEffect } from 'react'
import { Icon } from '@mdi/react'
import { mdiDotsHorizontal } from '@mdi/js'
import { Avatar } from './Avatar'
import type { CommentThread } from '../hooks/useComment'
import { getRelativeTime } from '../utils/time'
import { t } from '@nextcloud/l10n'
import './CommentSidebar.scss'

interface CommentSidebarProps {
	threads: CommentThread[]
	activeThreadId: string | null
	isReadOnly?: boolean
	onThreadClick: (threadId: string) => void
	onDeleteThread: (threadId: string) => void
}

export function CommentSidebar({ threads, activeThreadId, isReadOnly, onThreadClick, onDeleteThread }: CommentSidebarProps) {
	const [activeMenuId, setActiveMenuId] = useState<string | null>(null)
	const menuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({})

	useEffect(() => {
		const handleClickOutsideMenus = (e: MouseEvent) => {
			const target = e.target as HTMLElement
			const isClickOnMenu = target.closest('.comment-sidebar__menu-button, .comment-sidebar__menu-dropdown')

			if (!isClickOnMenu) {
				setActiveMenuId(null)
			}
		}

		document.addEventListener('pointerdown', handleClickOutsideMenus)
		return () => document.removeEventListener('pointerdown', handleClickOutsideMenus)
	}, [])

	const toggleMenu = (threadId: string) => {
		setActiveMenuId(activeMenuId === threadId ? null : threadId)
	}

	const handleDeleteThread = (threadId: string) => {
		onDeleteThread(threadId)
		setActiveMenuId(null)
	}

	const renderMenu = (threadId: string) => {
		const isMenuOpen = activeMenuId === threadId
		if (!isMenuOpen) return null

		return (
			<div className="comment-sidebar__menu-dropdown">
				<button onClick={() => handleDeleteThread(threadId)}>
					{t('whiteboard', 'Delete thread')}
				</button>
			</div>
		)
	}

	if (threads.length === 0) {
		return (
			<div className="comment-sidebar">
				<div className="comment-sidebar__empty">
					{t('whiteboard', 'No comments yet')}
				</div>
			</div>
		)
	}

	const reversedThreads = [...threads].reverse()

	return (
		<div className="comment-sidebar">
			<div className="comment-sidebar__list">
				{reversedThreads.map(thread => {
					const firstComment = thread.comments[0]
					const replyCount = thread.comments.length - 1
					const isActive = activeThreadId === thread.id

					return (
						<div
							key={thread.id}
							className={`comment-sidebar__item ${isActive ? 'active' : ''}`}
							onClick={() => onThreadClick(thread.id)}
						>
							<Avatar
								userId={firstComment?.userId}
								displayName={firstComment?.author || 'Guest'}
								size={32}
								className="comment-sidebar__avatar"
							/>
							<div className="comment-sidebar__content">
								<div className="comment-sidebar__header-row">
									<strong className="comment-sidebar__author">
										{firstComment?.author || t('whiteboard', 'Guest')}
									</strong>
									<time className="comment-sidebar__time">
										{getRelativeTime(firstComment?.created)}
									</time>
								</div>
								<div className="comment-sidebar__text">
									{firstComment?.text}
								</div>
								{replyCount > 0 && (
									<div className="comment-sidebar__replies">
										{replyCount} {replyCount === 1 ? t('whiteboard', 'reply') : t('whiteboard', 'replies')}
									</div>
								)}
							</div>
							{!isReadOnly && (
								<div className="comment-sidebar__menu">
									<button
										ref={(el: HTMLButtonElement | null) => { menuButtonRefs.current[thread.id] = el }}
										className="comment-sidebar__menu-button button-vue"
										onClick={(e) => {
											e.stopPropagation()
											toggleMenu(thread.id)
										}}
									>
										<Icon path={mdiDotsHorizontal} size={0.75} />
									</button>
									{renderMenu(thread.id)}
								</div>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}
