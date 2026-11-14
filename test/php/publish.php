<?php

declare(strict_types=1);

/*
 * Publishes through fancy-cowork-php's OWN publisher (PusherHttpClient, the
 * `fancy-pusher` broadcasting driver's client), so the HTTP API is tested
 * against the PHP code Laravel apps run, not a reimplementation of it.
 *
 * argv: <fancy-cowork-php dir> <config json>
 * config: { host, port, app_id, key, secret, channels: [], event, payload: {}, socket_id?, secret_override? }
 * Prints one JSON line: {"ok":true} or {"ok":false,"error":"..."}.
 */

[$_, $dir, $json] = $argv + [null, null, null];
require $dir.'/vendor/autoload.php';

use FancyCowork\Broadcasting\PusherHttpClient;
use Illuminate\Http\Client\Factory;

$c = json_decode((string) $json, true, 512, JSON_THROW_ON_ERROR);
$factory = new Factory;
$client = PusherHttpClient::fromConfig(
    fn () => $factory,
    [
        'key' => $c['key'],
        'secret' => $c['secret_override'] ?? $c['secret'],
        'app_id' => $c['app_id'],
        'options' => ['host' => $c['host'], 'port' => $c['port'], 'scheme' => 'http', 'useTLS' => false],
    ],
);

try {
    $client->trigger($c['channels'], $c['event'], $c['payload'], $c['socket_id'] ?? null);
    echo json_encode(['ok' => true]), "\n";
} catch (Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]), "\n";
}
