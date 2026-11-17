# Using @particle-academy/fancy-sockets — guide for agents

How an agent installs and uses this package in a consumer app. What the package
is, is in [README.md](./README.md). Notes for working ON this repo's code are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Install

```bash
npm install @particle-academy/fancy-sockets
```

- **Node:** `>=22`. One runtime dependency, `@particle-academy/fancy-ws`.
- Clients: pusher-js, Laravel Echo, and Laravel's HTTP broadcaster
  (pusher-php-server's wire format). Windows, Linux and macOS, no Docker.

## Find it on the Fancy MCP server

The catalog server is `https://ui.particle.academy/mcp` (streamable HTTP, no API
key; MCP id `fancy-ui`). fancy-sockets is not listed there yet; it appears once
published. Find it then with `search-backend-packages` (stack `node`).

## API essentials

**CLI, for tests and CI:**

```bash
npx @particle-academy/fancy-sockets --app my-app:my-key:my-secret --port 6001
```

- The first stdout line is JSON: `{"ready":true,"url":...,"wsUrl":...,"port":...,"apps":[...]}`.
  Wait for it before pointing the app at the server.
- `--port 0` picks a free port. `--app id:key:secret:client-events` allows
  whispers. `--self-signed --ca-out ca.pem` serves `wss` and writes the CA to
  trust (Node: `NODE_EXTRA_CA_CERTS=ca.pem`). `--tls-cert` / `--tls-key` for
  your own certificate.
- A Laravel app points at it with `BROADCAST_CONNECTION=reverb` (or `pusher`)
  and the matching `REVERB_APP_ID` / `_KEY` / `_SECRET`, `REVERB_HOST`,
  `REVERB_PORT`, `REVERB_SCHEME`. The README has a full GitHub Actions step.

**From a Node test:** `startTestServer({ app: { clientEvents: true } })` returns
`{ url, wsUrl, port, app: { id, key, secret }, stop }`; `{ tls: true }` adds
`ca`.

**Embedded:** `start({ port, host, apps })`, then `addApp`, `updateApp`,
`removeApp`, `getApp`, `apps`, `stats`, `stop({ timeoutMs })`. Also exported:
`createSelfSignedCert`, `signChannel`, `signedApiQuery`, `CODES`,
`DEFAULT_APP_LIMITS`, `DEFAULT_GLOBAL_LIMITS`.

Protocol: clients connect to `/app/{key}?protocol=7`; the HTTP API is
`POST /apps/{id}/events`, `/batch_events` and the `GET /apps/{id}/channels...`
routes; `GET /up` is the health check.

## Traps

- **Client events (whispers) are off by default**, per app, and only allowed on
  a subscribed private or presence channel, never encrypted.
- **The default host is `127.0.0.1`.** Use `0.0.0.0` to accept remote clients.
- **Single process only.** Apps, channels and presence live in memory; there is
  no cross-process broker in 0.1.
- **Not in 0.1:** webhooks, `pusher:signin`, cache channels.
- **`createSelfSignedCert()` is for tests and CI**, not production (valid 7
  days). In production, terminate TLS at a proxy and forward the `Upgrade`
  header, or pass `tls: { cert, key }`.
- **Changing an app's key or secret closes its sockets** (4200, they reconnect);
  disabling an app closes them with 4003; removing it, 4001.
- **Every limit has a default** (for example 1000 connections per app, 10
  events per batch, 50 messages per second per socket) and is refused with the
  protocol's code, never a crash. The README lists them all.
- **Pre-1.0:** breaking changes land in MINOR releases.
