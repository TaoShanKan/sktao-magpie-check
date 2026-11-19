import { startServer } from './server.js';
const service = await startServer();
console.log(`模型质量：http://127.0.0.1:${service.port}/`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await service.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
