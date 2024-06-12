// SPDX-FileCopyrightText: Ferdinand Thiessen <opensource@fthiessen.de>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAppConfig } from '@nextcloud/vite-config'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { defineConfig } from 'vite'

const AppConfig = createAppConfig({
	main: 'src/main.tsx',
}, {
	config: defineConfig({
		css: {
			modules: {
				localsConvention: 'camelCase',
			},
		},
		optimizeDeps: {
			esbuildOptions: {
				jsx: 'automatic',
			},
		},
		esbuild: {
			jsxInject: 'import React from \'react\'',
		},
		plugins: [
			react({
				jsxRuntime: 'classic',
			}),
			viteStaticCopy({
				targets: [
					{
						src: './node_modules/@excalidraw/excalidraw/dist/excalidraw-assets/*',
						dest: './dist/excalidraw-assets',
					},
				],
			}),
		],
	}),
})

export default AppConfig
