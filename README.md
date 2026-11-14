# @particle-academy/fancy-sockets

A **Pusher-protocol WebSockets server** for Node 22+. One process hosts many
apps, each with its own id, key and secret, and apps can be added, changed or
removed while it runs. It works with **pusher-js**, **Laravel Echo** and
Laravel's HTTP broadcaster (pusher-php-server's wire format), on Windows and
Linux, with no Docker.

```bash
npm install @particle-academy/fancy-sockets
```

Its one runtime dependency is [`ws`](https://github.com/websockets/ws), used for
WebSocket framing only. The Pusher protocol, channel auth, API signatures,
presence and limits are this package's own code.

## In tests and CI: one command

```bash
npx @particle-academy/fancy-sockets --app my-app:my-key:my-secret --port 6001
```

`--port 0` picks a free port. The first line on stdout is JSON, so a script can
read where it landed:

```json
{"ready":true,"url":"http://127.0.0.1:6001","wsUrl":"ws://127.0.0.1:6001","port":6001,"apps":["my-app"]}
```

Add `:client-events` to an app (`--app id:key:secret:client-events`) to allow
whispers. Add `--self-signed` to serve `wss` with a fresh certificate, and
`--ca-out ca.pem` to write the certificate a client should trust.

From a Node test:

```ts
import { startTestServer } from '@particle-academy/fancy-sockets';

const t = await startTestServer({ app: { clientEvents: true } });
// t.wsUrl, t.url, t.port, t.app = { id, key, secret }
// ... point pusher-js / Echo / your broadcaster at it ...
await t.stop();
```

`startTestServer({ tls: true })` serves wss and returns `t.ca`, the PEM to trust.

### GitHub Actions

Works on `ubuntu-latest` and `windows-latest` (and macOS) as is. Start it in
the background, wait for the ready line, and point the app at it:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: "22"

- name: Start a Pusher-protocol socket server
  shell: bash
  run: |
    npx -y @particle-academy/fancy-sockets@0 \
      --app ci-app:ci-key:ci-secret-0001:client-events \
      --port 6001 > sockets.log 2>&1 &
    for i in $(seq 1 50); do
      grep -q '"ready":true' sockets.log 2>/dev/null && break
      sleep 0.2
    done
    grep '"ready":true' sockets.log

- name: Test
  env:
    BROADCAST_CONNECTION: reverb      # or pusher; both speak this protocol
    REVERB_APP_ID: ci-app
    REVERB_APP_KEY: ci-key
    REVERB_APP_SECRET: ci-secret-0001
    REVERB_HOST: 127.0.0.1
    REVERB_PORT: "6001"
    REVERB_SCHEME: http
  run: php artisan test
```

For wss in CI, add `--self-signed --ca-out sockets-ca.pem` and have the client
trust `sockets-ca.pem` (Node: `NODE_EXTRA_CA_CERTS=sockets-ca.pem`).

## Embedding

```ts
import { start } from '@particle-academy/fancy-sockets';

const server = await start({
    port: 6001,
    host: '127.0.0.1',            // the default; use 0.0.0.0 to accept remote clients
    apps: [{ id: 'shop', key: 'shop-key', secret: process.env.SHOP_SECRET! }],
});

server.addApp({ id: 'blog', key: 'blog-key', secret: '...', clientEvents: true });
server.updateApp('blog', { limits: { maxConnections: 5000 } });   // live, no dropped sockets
server.removeApp('shop');                                         // closes only shop's sockets (4001)
server.stats();                                                   // connections, messages, refusals by kind
await server.stop();                                              // graceful: 4200 to every socket, then close
```

| method | does |
|---|---|
| `start(options)` | Listens and resolves with the server. `port: 0` picks a free port (`server.port`). |
| `addApp(app)` | Adds an app. Refuses a duplicate id or key. |
| `updateApp(id, patch)` | Applies new flags and limits to live sockets. A new key or secret closes that app's sockets with 4200 (they reconnect and re-authorise); disabling closes them with 4003. |
| `removeApp(id)` | Removes an app and closes its sockets with 4001. Other apps are untouched. |
| `getApp(id)`, `apps()` | The app's settings and counts. Never the secret. |
| `stats()` | Connections, apps, messages in and out, refusals by kind. |
| `stop({ timeoutMs })` | Refuses new work, closes every socket with 4200, waits up to `timeoutMs` (default 5000), then cuts what is left. |

Also exported: `startTestServer`, `createSelfSignedCert`, `signChannel` (for a
Node auth endpoint), `signedApiQuery` (for a Node publisher), `CODES`,
`DEFAULT_APP_LIMITS`, `DEFAULT_GLOBAL_LIMITS`.

### TLS

Behind a TLS-terminating proxy (nginx, Caddy, a load balancer), run it plain on
loopback and let the proxy forward `wss://` and `https://`, including the
`Upgrade` header. To serve TLS itself, pass `tls: { cert, key }` (PEM), or
`--tls-cert` and `--tls-key` on the CLI.

`createSelfSignedCert()` makes a P-256 certificate for `localhost`, `127.0.0.1`
and `::1` with node:crypto alone, valid for 7 days. It is for tests and CI, not
production.

## Protocol

- Clients connect to `/app/{key}?protocol=7` (5 to 7 accepted).
- Public, `private-`, `private-encrypted-` and `presence-` channels. Private and
  presence subscriptions are checked against
  `HMAC-SHA256(secret, "socket_id:channel[:channel_data]")`, in constant time.
- **Client events** (`client-*`, what Echo calls whispers) are an app setting,
  **off by default**, and only allowed on a subscribed private or presence
  channel, never encrypted. The server builds the relayed frame itself, so
  nothing the client put at the top level gets through. On a presence channel
  it sets `user_id` to the member that socket authenticated as, and ignores any
  value the client sent.
- HTTP API: `POST /apps/{id}/events` and `/batch_events`, and
  `GET /apps/{id}/channels`, `/channels/{name}` and `/channels/{name}/users`.
  Every call checks `auth_key`, `auth_version`, a 600-second timestamp window,
  `body_md5` and the signature. The body is size-capped before it is read and
  parsed only once authenticated. A batch is all-or-nothing.
- `pusher:ping` / `pusher:pong` both ways. The server announces
  `activity_timeout`, pings a socket that has been silent that long, and closes
  it with 4201 if no reply comes within `pongTimeoutMs`.
- `GET /up` answers `{"ok":true}`, for health checks.

## Limits

Every limit is a setting with a secure default. Going over one is refused with
the protocol's code and never takes the process down. One app's traffic cannot
use another app's budget.

| per app (`limits`) | default | over it |
|---|---|---|
| `maxConnections` | 1000 | close 4004 |
| `maxChannelsPerSocket` | 100 | `pusher:subscription_error` (LimitReached) |
| `maxPresenceMembers` | 100 | `pusher:subscription_error` (LimitReached) |
| `maxMessageBytes` | 10240 | close 1009 |
| `maxChannelDataBytes` | 1024 | `pusher:subscription_error` |
| `maxEventBytes` | 10240 | `pusher:error`, or HTTP 413 |
| `maxEventChannels` | 100 | HTTP 400 |
| `maxBatchEvents` | 10 | HTTP 400 |
| `messagesPerSecond` (per socket) | 50 | close 4301 |
| `clientEventsPerSecond` (per socket) | 10 | `pusher:error` 4301 |
| `apiRequestsPerSecond` | 100 | HTTP 429 |
| `maxBufferedBytes` (per socket) | 1 MiB | the socket is cut off as a slow consumer |

| process-wide (`limits` on `start`) | default | over it |
|---|---|---|
| `maxConnections` | 10000 | HTTP 503 at the handshake |
| `maxMessageBytes` | 65536 | close 1009, before the frame is buffered |
| `maxBodyBytes` | 102400 | HTTP 413 |
| `headersTimeoutMs` | 10000 | the connection is cut (slowloris) |
| `requestTimeoutMs` | 15000 | the connection is cut |

Idle checks run on one timer for the whole server, not one per socket.

## Not in 0.1

- **More than one process.** Apps, channels and presence live in this process's
  memory. Sharing them across processes would need a broker.
- Webhooks, `pusher:signin` user authentication, and cache channels.

## Licence

MIT.
