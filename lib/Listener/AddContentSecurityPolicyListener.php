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

	public function handle(Event $event): void {

		$policy = new EmptyContentSecurityPolicy();

		$policy->addAllowedConnectDomain("*");
		$event->addPolicy($policy);
	}
}
