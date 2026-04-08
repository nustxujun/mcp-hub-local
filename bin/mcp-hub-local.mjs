#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (process.argv.includes('--daemon')) {
  // Re-launch ourselves without --daemon as a detached background process
  const args = process.argv.slice(1).filter(a => a !== '--daemon');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.unref();
  console.log(`mcp-hub-local started in background (pid: ${child.pid})`);
  process.exit(0);
} else {
  const entry = join(__dirname, '..', 'apps', 'server', 'dist', 'index.js');
  await import(pathToFileURL(entry).href);
}
