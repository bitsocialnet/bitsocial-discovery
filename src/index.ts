import { buildServer } from './api/server.js';
import { config } from './config.js';
import { startDiscovery, stopDiscovery } from './discover.js';
import { getDb } from './db/index.js';
import { resetPkcClient } from './pkc/client.js';
import { startOverrides, stopOverrides } from './overrides.js';

async function main(): Promise<void> {
  getDb(); // initialise schema
  await startOverrides(); // apply the operator's verdicts before serving or fetching anything

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });

  // Idle unless the operator configured something to start from.
  void startDiscovery();

  const shutdown = async () => {
    stopDiscovery();
    stopOverrides();
    await app.close();
    await resetPkcClient();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
