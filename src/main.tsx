/**
 * @copyright Copyright (c) 2024 Julius Härtl <jus@bitgrid.net>
 *
 * @author Julius Härtl <jus@bitgrid.net>
 *
 * @license AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 *
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom";
import App from "./App";

import './viewer.css'

const Component = {
	name: 'Whiteboard',
	render(createElement) {
		this.$emit('update:loaded', true)
		this.$nextTick(() => {
			const rootElement = document.getElementById("whiteboard");
			const root = createRoot(rootElement);

			root.render(
				<StrictMode>
					<App />
				</StrictMode>
			);
		})
		return createElement('div', {
			attrs: {
				id: 'whiteboard',
			},
		}, 'Hello whiteboard')
	},
	props: {
		filename: {
			type: String,
			default: null,
		},
		fileid: {
			type: Number,
			default: null,
		},
	},
	data() {
		return {}
	},
}

if (typeof OCA.Viewer !== 'undefined') {
	window.OCA.Viewer.registerHandler({
		id: 'whiteboard',
		mimes: [
			'application/vnd.excalidraw+json'
		],
		component: Component,
		group: null,
		theme: 'default',
		canCompare: true,
	})
} else {
	alert('UNDEFINED')
}
