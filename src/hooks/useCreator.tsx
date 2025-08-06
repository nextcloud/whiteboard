export function useCreator() {

	const renderCreatedByUI = (uid: string) => {
		const el = document.createElement('div')
		el.classList.add('created-by')
		el.textContent = uid
		return el
	}
	const onPointerDown = (_activeTool, state) => {
		if (state.hit?.element?.customData?.created_by) {
			injectCreatedByUI(state.hit.element.customData.created_by)
		}
	}

	const injectCreatedByUI = (uid: string) => {
		const tryInject = () => {
			const sidePanel = document.getElementsByClassName('App-menu__left')[0]
			if (sidePanel) {
				const panelColumn = sidePanel.getElementsByClassName('panelColumn')[0]
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
