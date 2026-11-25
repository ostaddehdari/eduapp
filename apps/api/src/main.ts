import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}

const app = await createApp();
app.enableShutdownHooks();
await app.listen(port, process.env.HOST ?? '127.0.0.1');
