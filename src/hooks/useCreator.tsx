export function useCreator() {

	const renderCreatedByUI = (uid: string) => {
		const el = document.createElement('div')
		el.classList.add('created-by')
		el.textContent = uid
		return el
	}

	const removeCreatedByUI = () => {
		const elements = document.getElementsByClassName('created-by')
		Array.from(elements).forEach(element => {
			element.remove()
		})
	}

	const onPointerDown = (_activeTool, state) => {
		removeCreatedByUI()
		if (state.hit?.element?.customData?.created_by) {
			injectCreatedByUI(state.hit.element.customData.created_by.uid)
		}
	}

	const injectCreatedByUI = (uid: string) => {
		const tryInject = () => {
			const sidePanel = document.getElementsByClassName('App-menu__left')[0]
			if (sidePanel) {
				const panelColumn = sidePanel.getElementsByClassName('selected-shape-actions')[0]
				if (panelColumn && panelColumn.getElementsByClassName('created-by').length === 0) {
					panelColumn.appendChild(renderCreatedByUI(uid))
					return true
				}
			}
			return false
		}

		if (!tryInject()) {
			const interval = setInterval(() => {
				if (tryInject()) {
					clearInterval(interval)
				}
			}, 10)
		}
	}
	return { onPointerDown }
}
