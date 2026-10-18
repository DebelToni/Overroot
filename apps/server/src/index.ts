import { buildApp } from './app.js';
import { config } from './config.js';

const { app } = await buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Overroot is listening at http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
