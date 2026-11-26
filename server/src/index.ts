import http from 'http';
import { config } from './config';
import { createApp } from './app';
import { initRealtime } from './realtime';
import { prisma } from './db';

async function main() {
  await prisma.$connect();
  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);
  server.listen(config.port, () => {
    console.log(`🍽️  Servidor del restaurante escuchando en http://localhost:${config.port} (${config.env})`);
  });
  const shutdown = async () => {
    console.log('Cerrando servidor...');
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
