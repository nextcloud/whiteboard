<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Whiteboard\Listener;

use OCP\AppFramework\Http\EmptyContentSecurityPolicy;
use OCP\AppFramework\IAppContainer;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IRequest;
use OCP\Security\CSP\AddContentSecurityPolicyEvent;

/** @template-implements IEventListener<Event|AddContentSecurityPolicyEvent> */
class AddContentSecurityPolicyListener implements IEventListener {
	public function __construct(
		private IRequest $request,
		private IAppContainer $appContainer,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!$event instanceof AddContentSecurityPolicyEvent) {
			return;
		}

		$policy = new EmptyContentSecurityPolicy();

		$serverUrl = $this->appContainer->getConfig()->getAppValue('whiteboard', 'collabServerUrl', '');
		if ($serverUrl !== '') {
			$policy->addAllowedConnectDomain($serverUrl);
			$policy->addAllowedWorkerSrcDomain($serverUrl);
			$policy->addAllowedFontDomain($serverUrl);
		}

		$event->addPolicy($policy);
	}
}
