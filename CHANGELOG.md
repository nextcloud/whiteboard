# Changelog

## 1.4.2

### Features
* Add read-only EmbeddedViewer component for whiteboard nesting #800

### Fixed
* Fix recordings' file names for Windows compatibility #809
* Fix versions comparison, regular clean-ups, improve structure #774

### Other
* Add host environment variable to the websocket server #784
* Update node and npm engines versions #771
* Keep Nextcloud OCP development dependency up to date #785 #797 #810

## 1.4.1

### Features
* Add keyboard shortcuts to download the whiteboard screenshot #751

### Fixed
* Restore compatibility with Nextcloud 29 #754

### Other
* Update translations from Transifex and unify ellipses in strings #757
* Keep Nextcloud OCP development dependency up to date #748 #765
* Dependency updates: Node.js base image, axios, vitest, puppeteer-core, browserslist config, @nextcloud/e2e-test-server, @nextcloud/dialogs, @vitejs/plugin-react, phpunit #763 #761 #762 #764 #740 #742 #743 #745 #744 #741 #739 #759
* Run Playwright end-to-end tests across supported server versions #752

## 1.4.0

### Features
* Add whiteboard version history preview and restore workflow #735

### Fixed
* Restore whiteboard export images and keyboard shortcuts #703
* Prevent stale scene updates during collaboration sync #705
* Store recording temp files safely on the backend #706
* Add missing translation strings in the interface #736

### Other
* Update translations from Transifex
* Align browserslist baseline support with the updated configuration #707
* Dependency updates: Node.js, Vite, Playwright, Puppeteer, @nextcloud packages, Dexie, Socket.IO Prometheus, PHPUnit #691 #692 #693 #694 #695 #696 #697 #698 #699 #700 #708 #709 #711 #712 #713 #714 #715 #716 #717 #719

## 1.3.0

### Features
* Add creator information for whiteboard elements #546

### Other
* Add documentation for recording feature #685
* Add load testing tooling #665
* Keep Nextcloud OCP development dependency up to date #675 #683
* Dependency updates: TypeScript, Puppeteer, @vitejs/plugin-react, dotenv, vite-plugin-static-copy, PHPUnit, Node.js 24.9.0 #677 #678 #679 #680 #681 #682

## 1.2.1

### Fixed
* Improve board synchronization reliability and reduce race conditions #656
* Update translations from Transifex

### Other
* Keep Nextcloud OCP development dependency up to date #654 #661
* Dependency updates: axios, @nextcloud/dialogs, @nextcloud/vue, @vitejs/plugin-react, Puppeteer, Node.js 24.8.0, PHPUnit #649 #650 #651 #652 #653 #657 #658 #659 #660

## 1.2.0

### Features
* Recording: Add presentation recording functionality #559

### Fixed
* Fix collaborators synchronization issues #646
* Fix stale JWT token handling #645
* Fix saving library items #630
* Fix npm run watch command #627

### Other
* Improve frontend logging and error handling #629
* Update Node.js and npm engine requirements #628
* Update Nextcloud OCP dependencies

## 1.1.3

### Features
* Assistant Integration: Add AI assistant support for generating Mermaid diagrams by @grnd-alt in https://github.com/nextcloud/whiteboard/pull/581
* Grid Toggle: Add grid toggle button for better drawing precision by @luka-nextcloud in https://github.com/nextcloud/whiteboard/pull/532
* Library Support: Enhanced library functionality for better asset management by @luka-nextcloud in https://github.com/nextcloud/whiteboard/pull/473

### Fixed
* Fix file locking issues and improve file handling reliability by @hweihwang in https://github.com/nextcloud/whiteboard/pull/600
* Fix compatibility issues with Nextcloud 28 by @hweihwang in https://github.com/nextcloud/whiteboard/pull/573
* Update Redis client to support Unix socket connections by @Object9050 in https://github.com/nextcloud/whiteboard/pull/603

### Other
* Update Excalidraw to v0.18.0 with latest features and improvements by @hweihwang in https://github.com/nextcloud/whiteboard/pull/543
* Update @nextcloud/ocp and other core dependencies for better compatibility
* Update README with improved Docker Compose image tag by @st3iny in https://github.com/nextcloud/whiteboard/pull/525
* Update codeowners by @kesselb in https://github.com/nextcloud/whiteboard/pull/610

## 1.1.2

### Fixed
* Fix admin connectivity checks by @hweihwang in https://github.com/nextcloud/whiteboard/pull/527

## 1.1.1

### Fixed
* Fix data leaked between boards by @hweihwang in https://github.com/nextcloud/whiteboard/pull/510

### Other
* Update translations from Transifex

## 1.1.0

### Fixed
* Fix Redis client connection issues by @hweihwang in https://github.com/nextcloud/whiteboard/pull/477
* Add missing slash on Apache2 config by @wglp in https://github.com/nextcloud/whiteboard/pull/484

### Other
* Fix URL being rewritten, Add Apache docs, Improve logging, Fix server hanging when enable socket redis stream adapter, Fix JWT token mismatched by @hweihwang in https://github.com/nextcloud/whiteboard/pull/486
* Add Playwright tests by @juliusknorr in https://github.com/nextcloud/whiteboard/pull/361

## 1.1.0-beta.1

### Features
* local centric by @hweihwang in https://github.com/nextcloud/whiteboard/pull/393
* server data integrate by @hweihwang in https://github.com/nextcloud/whiteboard/pull/449
* feat: Add setup check to verify whiteboard backend server version and connectivity by @juliusknorr in https://github.com/nextcloud/whiteboard/pull/297
* Update docker-compose.yml by @joergmschulz in https://github.com/nextcloud/whiteboard/pull/356
* Add traefik configuration hints by @jensens in https://github.com/nextcloud/whiteboard/pull/352

### Fixed
* fix setup check trailing spaces by @hweihwang in https://github.com/nextcloud/whiteboard/pull/401
* Fix undo handling on initial load by @juliusknorr in https://github.com/nextcloud/whiteboard/pull/431

## 1.0.5

### Features
- Compatibility with Nextcloud 31
- Upload other files then images to whiteboards @grnd-alt [#278](https://github.com/nextcloud/whiteboard/pull/278)
- feat: Add option to take screenshot of the visible area @juliusknorr [#325](https://github.com/nextcloud/whiteboard/pull/325)
- Data management improvements @hweihwang [#259](https://github.com/nextcloud/whiteboard/pull/259)
- feat(Dockerfile): do not pin alpine version @szaimen [#241](https://github.com/nextcloud/whiteboard/pull/241)

### Fixed
- Fix server crashed, regular cleanups, improve configs, etc... @hweihwang [#306](https://github.com/nextcloud/whiteboard/pull/306)
- fix: prevent preview div from collapsing to 0px height @pbirrer [#277](https://github.com/nextcloud/whiteboard/pull/277)
- fix #183 typo in Readme for nginx reverse configuration @EricMeallier [#242](https://github.com/nextcloud/whiteboard/pull/242)
- fix: failed to update nextcloud/ocp package on branch main @hweihwang [#240](https://github.com/nextcloud/whiteboard/pull/240)
- add excalidraw type to whiteboard file @grnd-alt [#255](https://github.com/nextcloud/whiteboard/pull/255)

### Other
- add reverse proxy config example for Apache >= 2.4.47 @DanScharon [#282](https://github.com/nextcloud/whiteboard/pull/282)
- chore(readme): add exemplary configuration for Caddy v2 @st3iny [#213](https://github.com/nextcloud/whiteboard/pull/213)

## 1.0.4

### Fixed

- support translation @hweihwang [#200](https://github.com/nextcloud/whiteboard/pull/200)
- fix: use system theme if no ncTheme available @grnd-alt [#215](https://github.com/nextcloud/whiteboard/pull/215)
- fix: Properly handle metrics aggregation with room data @juliushaertl [#224](https://github.com/nextcloud/whiteboard/pull/224)
- fix: Generate proper URL for token endpoint @juliushaertl [#209](https://github.com/nextcloud/whiteboard/pull/209)
- set viewmode if share is readonly @grnd-alt [#216](https://github.com/nextcloud/whiteboard/pull/216)
- fix: Proper fallback for app config methods on Nextcloud 28 @juliushaertl [#206](https://github.com/nextcloud/whiteboard/pull/206)
- fix: Color picker buttons too wide @konradmb [#211](https://github.com/nextcloud/whiteboard/pull/211)

### Other

- docs: Storage strategies & Scaling @hweihwang [#198](https://github.com/nextcloud/whiteboard/pull/198)
- test: Add vitest and some basic integration tests @juliushaertl [#146](https://github.com/nextcloud/whiteboard/pull/146)
- docs: Enhance setup documentation @juliushaertl [#210](https://github.com/nextcloud/whiteboard/pull/210)

## 1.0.3

- Start translating the app #202
- public shares check for mimetype #201

## 1.0.2

### Fixed

- fix: Make template file creator registration compatible with 28/29 @juliushaertl [#169](https://github.com/nextcloud/whiteboard/pull/169)
- fix: Use proper server url parameter from the frontend @juliushaertl [#167](https://github.com/nextcloud/whiteboard/pull/167)
- fix: Update room data in storage when adding a file @juliushaertl [#170](https://github.com/nextcloud/whiteboard/pull/170)
- fix: Properly set URL for settings check if running in a subdirectory @juliushaertl [#158](https://github.com/nextcloud/whiteboard/pull/158)

## 1.0.1

### Fixed

- fix: Include composer dependencies in the release bundle @juliushaertl [#157](https://github.com/nextcloud/whiteboard/pull/157)

## 1.0.0

Initial release

## 1.0.0-rc.2

### Other

- improve Dockerfile @Zoey2936 [#145](https://github.com/nextcloud/whiteboard/pull/145)
- Fix metrics endpoint crash

## 1.0.0-rc.1

Initial release
