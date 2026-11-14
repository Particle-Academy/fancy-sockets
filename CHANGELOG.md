# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

**This package is pre-1.0, so breaking changes land in MINOR releases.** The
version number is not a stability promise until 1.0; read the entry.

## [Unreleased]

### Added

- **First release: a Pusher-protocol WebSockets server for Node 22+** (council
  change CC-fancy-0041). Nothing to migrate; this is new.
  - One process hosts many apps, each with its own id, key and secret.
    `addApp`, `updateApp` and `removeApp` work at runtime; removing an app
    closes only its sockets (4001), and other apps are never touched.
  - Public, private, encrypted and presence channels with HMAC channel auth;
    the HTTP API (`events`, `batch_events`, channel and user queries) with
    signature, timestamp-window and `body_md5` checks. Works with pusher-js,
    Laravel Echo and fancy-cowork-php's `fancy-pusher` publisher.
  - Client events are an app setting, off by default, private and presence
    channels only. On presence the server stamps `user_id` from the member it
    authenticated and ignores the client's value.
  - Bounded resources: per-socket, per-app and process-wide limits, each
    refused with the protocol's code. Slow consumers are cut off; slowloris
    handshakes time out.
  - `startTestServer()`, a CLI (`fancy-sockets --app id:key:secret --port 0`)
    that prints its bound port as JSON, `--watch` to reload apps from a config
    file, and `createSelfSignedCert()` for wss in CI, with node:crypto only.
- **Runtime dependency `ws`** (`^8.23.0`, MIT, 0 dependencies), owner-approved
  for WebSocket framing only.
- **Test dependencies `pusher-js` and `laravel-echo`**, under the framework
  test carve-out: the conformance suite drives the real clients Laravel apps
  ship. They are devDependencies and never reach a consumer.
