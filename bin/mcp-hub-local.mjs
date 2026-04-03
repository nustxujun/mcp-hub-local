#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const entry = join(__dirname, '..', 'apps', 'server', 'dist', 'index.js');

await import(pathToFileURL(entry).href);
