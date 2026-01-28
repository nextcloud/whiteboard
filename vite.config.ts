// SPDX-FileCopyrightText: Ferdinand Thiessen <opensource@fthiessen.de>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAppConfig } from '@nextcloud/vite-config'
import react from '@vitejs/plugin-react'
import { defineConfig, normalizePath } from 'vite'
import { join, resolve } from 'path'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const EXCALIDRAW_FONTS_DIR = normalizePath(resolve('node_modules/@nextcloud/excalidraw/dist/prod/fonts'))

const AppConfig = createAppConfig({
	main: resolve(join('src', 'main.ts')),
	settings: resolve(join('src', 'admin.ts')),
	personal: resolve(join('src', 'personal.ts')),
}, {
	config: defineConfig({
		resolve: {
			alias: [
				{
					find: /^@excalidraw\/element(.*)$/,
					replacement: '@nextcloud/excalidraw-element$1',
				},
				{
					find: /^@excalidraw\/excalidraw(.*)$/,
					replacement: '@nextcloud/excalidraw$1',
				},
			],
		},
		build: {
			cssCodeSplit: true,
			chunkSizeWarningLimit: 3000,
			minify: 'esbuild',
			target: 'es2020',
			rollupOptions: {
				output: {
					manualChunks: {
						vendor: ['react', 'react-dom'],
					},
					// assetFileNames: 'js/[name]-[hash].[ext]',
				},
			},
		},
		worker: {
			format: 'es',
			rollupOptions: {
				output: {
					entryFileNames: 'js/[name]-[hash].js',
				},
			},
		},
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
						src: EXCALIDRAW_FONTS_DIR,
						dest: 'dist',
					},
				],
			}),
		],

	}),
})

export default AppConfig
