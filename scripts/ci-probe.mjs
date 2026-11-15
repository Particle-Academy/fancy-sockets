// Connects to a running server and waits for connection_established.
// Used by CI to prove a server started in one step still serves the next.
//   node scripts/ci-probe.mjs ws://127.0.0.1:6001 <key>
// Node 22's own WebSocket client (undici): no client dependency.

const [base, key] = process.argv.slice(2);
const ws = new WebSocket(`${base}/app/${key}?protocol=7`);
const timer = setTimeout(() => {
    console.error('no connection_established within 5 s');
    process.exit(1);
}, 5000);
ws.addEventListener('message', ({ data }) => {
    const frame = JSON.parse(String(data));
    if (frame.event === 'pusher:connection_established') {
        clearTimeout(timer);
        console.log(`connected: ${JSON.parse(frame.data).socket_id}`);
        ws.close();
        process.exit(0);
    }
});
ws.addEventListener('error', () => {
    console.error('WebSocket error');
    process.exit(1);
});
