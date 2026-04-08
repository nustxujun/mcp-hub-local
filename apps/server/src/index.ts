import Fastify from 'fastify';
import cors from '@fastify/cors';
import fstatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { McpRegistryService } from './services/mcp-registry.js';
import { WorkspaceService } from './services/workspace.js';

import { LogService } from './services/log.js';
import { SettingsService } from './services/settings.js';
import { RuntimePoolService } from './services/runtime-pool.js';
import { McpAggregator, AggregatedHandler, SessionStore } from './services/aggregator/index.js';
import { ConfigSyncService } from './services/config-sync.js';
import { HealthCheckService } from './services/health-check.js';
import { StatsService } from './services/stats.js';

import { registerMcpRoutes } from './routes/mcps.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

import { registerLogRoutes } from './routes/logs.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerStatsRoutes } from './routes/stats.js';
import { ConfigIOService } from './services/config-io.js';
import { DEFAULT_PORT } from '@mcp-hub-local/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(): { port?: number; config?: string; daemon?: boolean } {
  const args = process.argv.slice(2);
  const result: { port?: number; config?: string; daemon?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      result.port = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--config' && args[i + 1]) {
      result.config = args[i + 1];
      i++;
    } else if (args[i] === '--daemon') {
      result.daemon = true;
    }
  }
  return result;
}

function daemonize(): never {
  // Re-spawn ourselves without --daemon, detached and with stdio ignored.
  const args = process.argv.slice(2).filter(a => a !== '--daemon');
  const child = spawn(process.argv[0], [process.argv[1], ...args], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();
  console.log(`mcp-hub-local daemonized (pid=${child.pid})`);
  process.exit(0);
}

const APP_IDENTIFIER = 'mcp-hub-local';
const PID_FILE = path.join(process.cwd(), 'data', 'mcp-hub-local.pid');

interface PidInfo {
  pid: number;
  port: number;
}

function readPidFile(): PidInfo | null {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf-8');
    const info = JSON.parse(content);
    if (typeof info.pid === 'number' && typeof info.port === 'number') return info;
  } catch { /* file doesn't exist or is invalid */ }
  return null;
}

function writePidFile(pid: number, port: number): void {
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid, port }), 'utf-8');
}

function removePidFile(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

/**
 * Kill any previous mcp-hub-local instance, regardless of which port it was on.
 * 1. Read PID file to get the old instance's port
 * 2. HTTP probe /api/identity on that port to confirm it's mcp-hub-local
 * 3. Graceful shutdown via POST /api/shutdown, or force kill as fallback
 */
async function killPreviousInstance(newPort: number, log: any): Promise<void> {
  const pidInfo = readPidFile();

  // Collect ports to check: the recorded port (if any) + the new port (in case PID file is stale)
  const portsToCheck = new Set<number>();
  if (pidInfo) portsToCheck.add(pidInfo.port);
  portsToCheck.add(newPort);

  for (const port of portsToCheck) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`http://127.0.0.1:${port}/api/identity`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const body = await res.json() as { app?: string };
      if (body?.app !== APP_IDENTIFIER) {
        if (port === newPort) {
          log.warn(`Port ${port} is occupied by a different application (app=${body?.app}), will not kill it`);
        }
        continue;
      }
    } catch {
      // Connection refused or timeout — nothing running on this port
      continue;
    }

    log.info(`Detected a previous ${APP_IDENTIFIER} instance on port ${port}, shutting it down...`);

    // Try graceful shutdown first
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', signal: controller.signal });
      clearTimeout(timer);
      await new Promise(resolve => setTimeout(resolve, 1500));
      log.info('Previous instance shut down gracefully');
      continue;
    } catch {
      // Graceful shutdown failed
    }

    // Fallback: force kill by PID if we have it, otherwise by port
    log.warn('Graceful shutdown failed, force killing...');
    if (pidInfo && pidInfo.port === port) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /PID ${pidInfo.pid} /F`, { encoding: 'utf-8' });
        } else {
          execSync(`kill -9 ${pidInfo.pid}`, { encoding: 'utf-8' });
        }
        log.info(`Previous instance (PID ${pidInfo.pid}) force killed`);
        continue;
      } catch { /* PID may already be gone, try by port */ }
    }

    try {
      if (process.platform === 'win32') {
        const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8' });
        const pids = new Set(
          output.split('\n')
            .map(line => line.trim().split(/\s+/).pop())
            .filter((pid): pid is string => !!pid && /^\d+$/.test(pid))
        );
        for (const pid of pids) {
          try { execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf-8' }); } catch { /* already gone */ }
        }
      } else {
        try { execSync(`lsof -ti :${port} | xargs kill -9`, { encoding: 'utf-8' }); } catch { /* ignore */ }
      }
      log.info('Previous instance force killed by port');
    } catch {
      log.warn(`Could not kill previous instance on port ${port}, startup may fail`);
    }
  }

  // Clean up stale PID file
  removePidFile();
}

async function main() {
  const cliArgs = parseArgs();

  if (cliArgs.daemon) {
    daemonize();
  }

  const { db, sqlite } = createDatabase();
  runMigrations(sqlite);

  const settingsService = new SettingsService(db);

  const app = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
  });

  await app.register(cors, { origin: true });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const str = (body as string || '').trim();
    if (!str) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(str));
    } catch (err: any) {
      done(err, undefined);
    }
  });

  const logService = new LogService(db);
  const registry = new McpRegistryService(db);
  const workspaceService = new WorkspaceService(db);
  const runtimePool = new RuntimePoolService(db, logService);
  const configSync = new ConfigSyncService(workspaceService, registry, settingsService, logService);
  const healthCheck = new HealthCheckService(registry);
  const statsService = new StatsService(db);
  const sessionStore = new SessionStore();
  const aggregator = new McpAggregator(sessionStore, runtimePool, workspaceService, registry, logService, statsService, settingsService, db);
  const configIO = new ConfigIOService(registry, workspaceService, runtimePool, aggregator, db);
  const handler = new AggregatedHandler(aggregator);

  // CLI: import config file on startup
  if (cliArgs.config) {
    const configPath = path.resolve(cliArgs.config);
    if (!fs.existsSync(configPath)) {
      app.log.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }
    try {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const result = await configIO.importConfig(configData);
      app.log.info(`Imported config from ${configPath}: ${result.created} items created`);
      if (result.errors.length > 0) {
        app.log.warn(`Import warnings: ${result.errors.join('; ')}`);
      }
    } catch (e: any) {
      app.log.error(`Failed to import config: ${e.message}`);
      process.exit(1);
    }
  }

  registerMcpRoutes(app, registry, healthCheck, runtimePool, aggregator, db);
  registerWorkspaceRoutes(app, workspaceService, registry, configSync, settingsService, aggregator);
  registerLogRoutes(app, logService);
  registerSettingsRoutes(app, settingsService, configSync, configIO);
  registerSessionRoutes(app, aggregator);
  registerStatsRoutes(app, statsService);

  // Identity endpoint — used by killPreviousInstance to confirm this is mcp-hub-local
  app.get('/api/identity', async () => ({ app: APP_IDENTIFIER }));

  app.all('/w/:workspaceSlug', async (request, reply) => {
    return handler.handleRequest(
      request as any,
      reply,
    );
  });

  const webDistCandidates = [
    path.resolve(__dirname, '../../web/dist'),
    path.resolve(process.cwd(), '../web/dist'),
    path.resolve(process.cwd(), 'apps/web/dist'),
  ];
  const webDistPath = webDistCandidates.find(p => fs.existsSync(path.join(p, 'index.html')));

  if (webDistPath) {
    await app.register(fstatic, {
      root: webDistPath,
      prefix: '/app/',
      decorateReply: true,
      wildcard: false,
    });
    app.get('/app', async (request, reply) => {
      return reply.redirect('/app/');
    });
    const indexHtml = path.join(webDistPath, 'index.html');
    app.get('/app/*', async (request, reply) => {
      // Try to serve the static file first; fall back to index.html for SPA routes
      const urlPath = (request.url.split('?')[0]).replace(/^\/app\//, '');
      if (urlPath) {
        const filePath = path.join(webDistPath, urlPath);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          return reply.sendFile(urlPath);
        }
      }
      const stream = fs.createReadStream(indexHtml);
      return reply.type('text/html').send(stream);
    });
    app.log.info('Serving Web UI from %s', webDistPath);
  } else {
    app.log.warn('Web UI dist not found — run "npm run build" in apps/web first');
    app.get('/app', async (request, reply) => {
      return reply.type('text/html').send('<html><body><h1>Web UI not built</h1><p>Run <code>npm run build</code> in apps/web</p></body></html>');
    });
    app.get('/app/*', async (request, reply) => {
      return reply.type('text/html').send('<html><body><h1>Web UI not built</h1><p>Run <code>npm run build</code> in apps/web</p></body></html>');
    });
  }

  app.get('/', async (request, reply) => {
    return reply.redirect('/app/');
  });

  const shutdown = async () => {
    app.log.info('Shutting down...');
    removePidFile();
    healthCheck.stop();
    await runtimePool.stopAll();
    await app.close();
    // Flush WAL to main db and release -wal/-shm files before closing
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.close();
    process.exit(0);
  };

  // Graceful shutdown endpoint — used by new instances to stop the old one
  app.post('/api/shutdown', async (request, reply) => {
    reply.send({ ok: true });
    setTimeout(() => shutdown(), 500);
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const portSetting = await settingsService.get<number>('port');
  const PORT = cliArgs.port || parseInt(process.env.PORT || '') || portSetting || DEFAULT_PORT;

  // Kill any previous mcp-hub-local instance on the same port
  await killPreviousInstance(PORT, app.log);

  await app.listen({ port: PORT, host: '0.0.0.0' });
  writePidFile(process.pid, PORT);
  healthCheck.start();
  app.log.info(`MCP Hub Local running on http://localhost:${PORT}`);
  app.log.info(`  API:     http://localhost:${PORT}/api`);
  app.log.info(`  Web UI:  http://localhost:${PORT}/app`);
  app.log.info(`  MCP:     http://localhost:${PORT}/w/<workspaceSlug>`);

  // Auto-start MCPs and sync workspace configs (non-blocking)
  (async () => {
    try {
      const mcps = await registry.list();
      if (mcps.length > 0) {
        app.log.info(`Auto-starting ${mcps.length} configured MCP(s)...`);
        let started = 0;
        for (const mcp of mcps) {
          try {
            await runtimePool.startAndInitialize(mcp);
            started++;
          } catch (err: any) {
            app.log.warn(`Failed to auto-start MCP "${mcp.slug}": ${err.message}`);
          }
        }
        app.log.info(`Auto-started ${started}/${mcps.length} MCP(s)`);
      }

      await configSync.syncAllWorkspaces();
      app.log.info('Auto-synced all workspace configs to clients');
    } catch (err: any) {
      app.log.error(`Auto-startup sequence failed: ${err.message}`);
    }
  })();
}

main().catch((err) => {
  console.error('Failed to start MCP Hub Local:', err);
  process.exit(1);
});
