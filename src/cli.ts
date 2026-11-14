import { UsageError, main } from './cli-main.js';

const io = { out: (l: string) => process.stdout.write(`${l}\n`), err: (l: string) => process.stderr.write(`${l}\n`) };

main(process.argv.slice(2), io)
    .then((server) => {
        if (server === null) {
            return;
        }
        let stopping = false;
        const shutdown = (): void => {
            if (stopping) {
                process.exit(1);
            }
            stopping = true;
            void server.stop().then(() => process.exit(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    })
    .catch((err: Error) => {
        io.err(err instanceof UsageError ? `fancy-sockets: ${err.message}\n\nRun fancy-sockets --help for usage.` : `fancy-sockets: ${err.message}`);
        process.exit(2);
    });
