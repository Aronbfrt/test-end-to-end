import { resolve } from 'node:path';
import { startServer } from './app.js';

const targetPath = process.argv[2] ? resolve(process.argv[2]) : resolve(process.cwd());
const port = parseInt(process.env.E2E_PORT ?? '4321', 10);

startServer(targetPath, port);
