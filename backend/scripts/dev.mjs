// npm run dev: runs the API and restarts it when the code or backend/.env changes, so a new
// AI_PROVIDER (or any other setting) takes effect without a manual restart. Node's own watch mode
// is used because tsx watch never watches dotfiles such as .env. Run from backend/.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = [
  '--watch-path=./src',
  ...(existsSync('.env') ? ['--watch-path=./.env'] : []),
  '--watch-preserve-output',
  '--import', 'tsx',
  'src/server.ts',
];
const child = spawn(process.execPath, args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
