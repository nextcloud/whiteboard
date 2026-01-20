/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@mdi/react'
import { mdiClose, mdiDotsHorizontal } from '@mdi/js'
import { getCurrentUser } from '@nextcloud/auth'
import { Avatar } from './Avatar'
import type { CommentThread, Comment } from '../hooks/useComment'
import { getRelativeTime } from '../utils/time'
import { t } from '@nextcloud/l10n'
import './CommentPopover.scss'

interface CommentPopoverProps {
	x: number
	y: number
	commentThread: CommentThread | null
	isReadOnly?: boolean
	onClose: () => void
	onSubmitComment: (text: string) => void
	onEditComment: (commentId: string, text: string) => void
	onDeleteThread: () => void
}

function calculateMenuPosition(buttonRect: DOMRect, popoverRect: DOMRect) {
	return {
		left: `${buttonRect.right - popoverRect.left - 120}px`,
		top: `${buttonRect.bottom - popoverRect.top + 4}px`,
	}
}

export function CommentPopover({
	x,
	y,
	commentThread,
	isReadOnly,
	onClose,
	onSubmitComment,
	onEditComment,
	onDeleteThread,
}: CommentPopoverProps) {
	const popoverRef = useRef<HTMLDivElement>(null)
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const listRef = useRef<HTMLDivElement>(null)
	const headerMenuButtonRef = useRef<HTMLButtonElement>(null)
	const commentMenuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
	const shouldAutoScrollRef = useRef(true)

	const [inputText, setInputText] = useState('')
	const [editingComment, setEditingComment] = useState<{ id: string, text: string } | null>(null)
	const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false)
	const [activeCommentMenuId, setActiveCommentMenuId] = useState<string | null>(null)

	const currentUser = getCurrentUser()
	const currentUserName = currentUser?.displayName || t('whiteboard', 'Guest')
	const hasComments = Boolean(commentThread?.comments.length)

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
				onClose()
			}
		}

		document.addEventListener('pointerdown', handleClickOutside)
		return () => document.removeEventListener('pointerdown', handleClickOutside)
	}, [onClose])

	useEffect(() => {
		const handleClickOutsideMenus = (e: MouseEvent) => {
			const target = e.target as HTMLElement
			const isClickOnMenu = target.closest('.comment-popover__menu-button, .comment-popover__header-menu, .comment-popover__menu-dropdown')

			if (!isClickOnMenu) {
				setIsHeaderMenuOpen(false)
				setActiveCommentMenuId(null)
			}
		}

		document.addEventListener('pointerdown', handleClickOutsideMenus)
		return () => document.removeEventListener('pointerdown', handleClickOutsideMenus)
	}, [])

	useEffect(() => {
		if (listRef.current && shouldAutoScrollRef.current) {
			listRef.current.scrollTop = listRef.current.scrollHeight
		}
	}, [commentThread?.comments])

	useEffect(() => {
		const listElement = listRef.current
		if (!listElement) return

		const handleScroll = () => {
			const { scrollTop, scrollHeight, clientHeight } = listElement
			const distanceFromBottom = scrollHeight - scrollTop - clientHeight
			shouldAutoScrollRef.current = distanceFromBottom < 10
		}

		listElement.addEventListener('scroll', handleScroll)
		return () => listElement.removeEventListener('scroll', handleScroll)
	}, [])

	const resetInputHeight = () => {
		if (textareaRef.current) {
			textareaRef.current.style.height = 'auto'
		}
	}

	const adjustInputHeight = () => {
		if (textareaRef.current) {
			textareaRef.current.style.height = 'auto'
			textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`
		}
	}

	const handleSubmitComment = () => {
		const trimmedText = inputText.trim()
		if (!trimmedText) return

		onSubmitComment(trimmedText)
		setInputText('')
		resetInputHeight()
	}

	const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setInputText(e.target.value)
		adjustInputHeight()
	}

	const handleInputKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			handleSubmitComment()
		}
	}

	const startEditingComment = (commentId: string, commentText: string) => {
		setEditingComment({ id: commentId, text: commentText })
		setActiveCommentMenuId(null)
	}

	const cancelEditingComment = () => {
		setEditingComment(null)
	}

	const saveEditedComment = () => {
		if (!editingComment?.text.trim()) return

		onEditComment(editingComment.id, editingComment.text.trim())
		setEditingComment(null)
	}

	const handleDeleteThread = () => {
		onDeleteThread()
		setIsHeaderMenuOpen(false)
	}

	const toggleHeaderMenu = () => {
		setActiveCommentMenuId(null)
		setIsHeaderMenuOpen(!isHeaderMenuOpen)
	}

	const toggleCommentMenu = (commentId: string) => {
		setIsHeaderMenuOpen(false)
		setActiveCommentMenuId(activeCommentMenuId === commentId ? null : commentId)
	}

	const renderHeaderMenu = () => {
		if (!isHeaderMenuOpen || !headerMenuButtonRef.current || !popoverRef.current) return null

		const buttonRect = headerMenuButtonRef.current.getBoundingClientRect()
		const popoverRect = popoverRef.current.getBoundingClientRect()
		const position = calculateMenuPosition(buttonRect, popoverRect)

		return (
			<div className="comment-popover__header-menu" style={{ position: 'fixed', ...position }}>
				<button onClick={handleDeleteThread}>{t('whiteboard', 'Delete thread')}</button>
			</div>
		)
	}

	const renderCommentMenu = (commentId: string) => {
		const isMenuOpen = activeCommentMenuId === commentId
		const buttonRef = commentMenuButtonRefs.current[commentId]

		if (!isMenuOpen || !buttonRef || !popoverRef.current) return null

		const buttonRect = buttonRef.getBoundingClientRect()
		const popoverRect = popoverRef.current.getBoundingClientRect()
		const position = calculateMenuPosition(buttonRect, popoverRect)

		return (
			<div className="comment-popover__menu-dropdown" style={{ position: 'fixed', ...position }}>
				<button onClick={() => startEditingComment(commentId, commentThread!.comments.find(c => c.id === commentId)!.text)}>
					{t('whiteboard', 'Edit')}
				</button>
			</div>
		)
	}

	const renderCommentHeader = (comment: Comment, showMenu: boolean = false) => (
		<div className="comment-popover__item-header">
			<Avatar
				userId={comment.userId}
				displayName={comment.author}
				size={32}
				className="comment-popover__avatar"
			/>
			<div className="comment-popover__item-info">
				<strong className="comment-popover__author">{comment.author}</strong>
				<time className="comment-popover__time">{getRelativeTime(comment.created)}</time>
			</div>
			{showMenu && !isReadOnly && (
				<div className="comment-popover__menu">
					<button
						ref={(el: HTMLButtonElement) => { commentMenuButtonRefs.current[comment.id] = el }}
						className="comment-popover__menu-button button-vue"
						onClick={() => toggleCommentMenu(comment.id)}
					>
						<Icon path={mdiDotsHorizontal} size={0.75} />
					</button>
					{renderCommentMenu(comment.id)}
				</div>
			)}
		</div>
	)

	const renderCommentEdit = (comment: Comment) => {
		if (!editingComment || editingComment.id !== comment.id) return null

		return (
			<>
				{renderCommentHeader(comment, false)}
				<div className="comment-popover__edit">
					<textarea
						value={editingComment.text}
						onChange={(e) => setEditingComment({ ...editingComment, text: e.target.value })}
						onWheel={(e) => e.stopPropagation()}
						onTouchMove={(e) => e.stopPropagation()}
						autoFocus
						wrap="soft"
					/>
					<div className="comment-popover__edit-actions">
						<button className="button-vue" onClick={saveEditedComment}>
							{t('whiteboard', 'Save')}
						</button>
						<button className="button-vue" onClick={cancelEditingComment}>
							{t('whiteboard', 'Cancel')}
						</button>
					</div>
				</div>
			</>
		)
	}

	const renderCommentContent = (comment: Comment) => {
		const isCurrentUserComment = comment.author === currentUserName
		const isBeingEdited = editingComment?.id === comment.id

		if (isBeingEdited) {
			return renderCommentEdit(comment)
		}

		return (
			<>
				{renderCommentHeader(comment, isCurrentUserComment)}
				<p className="comment-popover__item-text">{comment.text}</p>
			</>
		)
	}

	return (
		<div
			ref={popoverRef}
			className="comment-popover"
			style={{ left: `${x}px`, top: `${y}px` }}
			onPointerDown={(e) => e.stopPropagation()}
		>
			<div className="comment-popover__content">
				{hasComments && (
					<>
						<div className="comment-popover__header">
							<h3>{t('whiteboard', 'Comments')}</h3>
							<div className="comment-popover__header-actions">
								{!isReadOnly && (
									<>
										<button
											ref={headerMenuButtonRef}
											className="comment-popover__menu-button button-vue"
											onClick={toggleHeaderMenu}
										>
											<Icon path={mdiDotsHorizontal} size={0.75} />
										</button>
										{renderHeaderMenu()}
									</>
								)}
								<button className="comment-popover__close button-vue" onClick={onClose}>
									<Icon path={mdiClose} size={0.75} />
								</button>
							</div>
						</div>

						<div className="comment-popover__list" ref={listRef}>
							{commentThread!.comments.map((comment) => (
								<div key={comment.id} className="comment-popover__item">
									{renderCommentContent(comment)}
								</div>
							))}
						</div>
					</>
				)}

				{!isReadOnly && (
					<div className="comment-popover__input-wrapper">
						<textarea
							ref={textareaRef}
							className="comment-popover__input"
							value={inputText}
							onChange={handleInputChange}
							onKeyDown={handleInputKeyDown}
							onWheel={(e) => e.stopPropagation()}
							onTouchMove={(e) => e.stopPropagation()}
							placeholder={hasComments ? t('whiteboard', 'Reply') : t('whiteboard', 'Add a comment')}
							rows={1}
							autoFocus
							wrap="soft"
						/>
						<button
							className="comment-popover__button comment-popover__button--primary button-vue"
							onClick={handleSubmitComment}
							disabled={!inputText.trim()}
						>
							{t('whiteboard', 'Send')}
						</button>
					</div>
				)}
			</div>
		</div>
	)
}
