<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Whiteboard\Listener;

use OCP\AppFramework\Http\EmptyContentSecurityPolicy;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IRequest;
use OCP\Security\CSP\AddContentSecurityPolicyEvent;

/** @template-implements IEventListener<Event|AddContentSecurityPolicyEvent> */
class AddContentSecurityPolicyListener implements IEventListener {
	public function __construct(
		private IRequest $request,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!$event instanceof AddContentSecurityPolicyEvent) {
			return;
		}

		$policy = new EmptyContentSecurityPolicy();

		$policy->addAllowedConnectDomain('*');
		$policy->addAllowedWorkerSrcDomain('*');
		$policy->addAllowedFontDomain('*');

		$event->addPolicy($policy);
	}
}
