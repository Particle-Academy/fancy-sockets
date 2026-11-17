# Contributing to @particle-academy/fancy-sockets

Notes for anyone, human or agent, working ON this package's code. How to USE the
package is in [AGENTS.md](./AGENTS.md); what it is, is in [README.md](./README.md).
`CLAUDE.md` is a symlink to this file, so Claude Code reads these notes when it
works in this repo.

**This file describes THIS REPO'S CODE and nothing else.** Process rules —
lifecycle, version policy, publishing procedure, backports — live in the
envelope's `RULES.md` and must never be copied here.

## What this package is

A Pusher-protocol WebSockets server for Node 22+: many apps in one process,
changed at runtime. `@particle-academy/fancy-ws` (first-party, zero dependencies) does RFC 6455
framing and nothing else; everything
protocol-level is ours.

## Layout

| file | what lives there |
|---|---|
| `src/protocol.ts` | Pure: signatures, name rules, close codes, the token bucket. No I/O. |
| `src/config.ts` | App and global settings, defaults, validation. Errors name the field, never a value. |
| `src/state.ts` | Per-app sockets and channels. Each app owns its maps; nothing is shared. |
| `src/connection.ts` | One socket's messages: subscribe, unsubscribe, presence, client events. |
| `src/http-api.ts` | The HTTP API. Authenticates before it parses anything. |
| `src/server.ts` | The listener, the upgrade path, the idle sweep, runtime apps, graceful stop. |
| `src/cert.ts` | Self-signed certificates, hand-encoded DER over node:crypto. |
| `src/cli-main.ts` / `src/cli.ts` | The CLI as a testable function, and its thin bin. |

## Invariants (each has a test, and a sabotage entry that proves it)

1. **The server stamps the presence sender.** A client event's outgoing frame
   is built field by field in `connection.ts`; `user_id` comes from
   `socket.members`, never from the message. Anything else the client put at
   the top level is dropped.
2. **Client events are off unless the app turns them on**, and only on a
   subscribed private or presence channel.
3. **The HTTP API trusts nothing before the signature.** Route, app, rate,
   capped body read, then key, version, timestamp, md5 and signature. Only then
   is the body parsed.
4. **No app can reach another app's state.** Channels are per `AppState`.
5. **A limit is refused, never thrown.** Handlers send a protocol error; the
   message loop still wraps them so a bug costs one socket.
6. **Presence hashes are null-prototype objects.** A `user_id` of `__proto__`
   is just an id.
7. **One sweep timer per server**, not a timer per socket.

## Traps

- Node checks `headersTimeout` only every `connectionsCheckingInterval` (30 s
  by default), so the server sets that interval from the limit. And
  `clientError`'s `end()` only half-closes: a slowloris keeps the socket unless
  it is destroyed after the status line flushes.
- Refused connections are accepted and then closed with a Pusher code, because
  pusher-js decides whether to reconnect from that code. Only the process-wide
  cap refuses at the handshake (503), where a flood costs a status line.

## Tests

Raw-protocol tests use `test/ws-client.ts`, a small RFC 6455 client of our
own over node:net/tls. It does not share fancy-ws's frame codec, so the server
is not checked against itself, and it can send an `Origin`, take a CA and see
the HTTP status of a refused handshake, which Node's `WebSocket` global cannot.

`npm test` (vitest). `test/php-publisher.test.ts` drives fancy-cowork-php's
own publisher through `php`; it needs a fancy-cowork-php checkout with
`vendor/` (`FANCY_COWORK_PHP_DIR`, or `../fancy-cowork-php`). With
`FANCY_SOCKETS_REQUIRE_PHP=1`, as CI sets it, a missing prerequisite fails.

`node scripts/sabotage.mjs` breaks each guard in turn and checks its test goes
red. It edits `src/` in place and restores it; run it on a clean tree, never in
CI. `npm run build && node scripts/smoke.mjs` checks the built artifact and the
CLI binary.

## Changelog

Update `CHANGELOG.md` in the same commit as the change.
