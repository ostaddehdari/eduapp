import { createServer } from 'node:http';
import { createGateway } from './gateway.mjs';

const port = Number(process.env.GATEWAY_PORT ?? 3010);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid GATEWAY_PORT');
const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, createGateway());
server.listen(port, '127.0.0.1', () => process.stdout.write('Gateway listening on 127.0.0.1:' + port + '\n'));
