<?php
/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
?>

<style>
    body {
        position: fixed;
        background-color: var(--color-main-background);
    }

    #whiteboard-app {
        width: 100%;
        height: 100%;
        position: fixed;
    }

    #body-public footer {
        position: static;
        left: auto;
        bottom: auto;
        transform: none;
        width: auto;
        max-width: none;
    }
</style>

<div id="whiteboard-app" class="whiteboard"></div>
