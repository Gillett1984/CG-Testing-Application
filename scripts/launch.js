// Launcher that sets NODE_EXTRA_CA_CERTS before Node boots the real entry
// point. NODE_EXTRA_CA_CERTS is only read at process start, so dotenv inside
// the app is too late — this wrapper is how the ui/test:case/preflight npm
// scripts pick up the local intercepting-proxy CA (see config/certs/README.md).
//
// Usage: node scripts/launch.js <entry.js> [...args]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { resolveCaEnv, describeCaEnv } from './localCaEnv.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error('Usage: node scripts/launch.js <entry.js> [...args]');
  process.exit(2);
}

const resolution = resolveCaEnv(rootDir, process.env);
console.log(`[launch] ${describeCaEnv(resolution)}`);

const child = spawn(process.execPath, [path.resolve(rootDir, entry), ...args], {
  cwd: rootDir,
  env: resolution.env,
  stdio: 'inherit',
  shell: false
});

child.on('close', (code) => process.exit(code ?? 1));
