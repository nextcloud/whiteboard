# Changelog

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
