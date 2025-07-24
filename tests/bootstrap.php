<?php

$nextcloud_source = getenv('NEXTCLOUD_SOURCE')
  ?: __DIR__ . '/../../..';
require_once $nextcloud_source . '/tests/bootstrap.php';

OC_App::loadApp('whiteboard');
OC_Hook::clear();
