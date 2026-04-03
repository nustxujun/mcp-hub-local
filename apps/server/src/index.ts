import Fastify from 'fastify';
import cors from '@fastify/cors';
import fstatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
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

import { registerMcpRoutes } from './routes/mcps.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

import { registerLogRoutes } from './routes/logs.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { ConfigIOService } from './services/config-io.js';
import { DEFAULT_PORT } from '@mcp-hub-local/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(): { port?: number; config?: string } {
  const args = process.argv.slice(2);
  const result: { port?: number; config?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      result.port = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--config' && args[i + 1]) {
      result.config = args[i + 1];
      i++;
    }
  }
  return result;
}

async function main() {
  const cliArgs = parseArgs();

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
  const sessionStore = new SessionStore();
  const aggregator = new McpAggregator(sessionStore, runtimePool, workspaceService, registry, logService);
  const configIO = new ConfigIOService(registry, workspaceService, runtimePool, aggregator);
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

  registerMcpRoutes(app, registry, healthCheck, runtimePool, aggregator);
  registerWorkspaceRoutes(app, workspaceService, registry, configSync, settingsService, aggregator);
  registerLogRoutes(app, logService);
  registerSettingsRoutes(app, settingsService, configSync, configIO);
  registerSessionRoutes(app, aggregator);

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
    healthCheck.stop();
    await runtimePool.stopAll();
    await app.close();
    sqlite.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const portSetting = await settingsService.get<number>('port');
  const PORT = cliArgs.port || parseInt(process.env.PORT || '') || portSetting || DEFAULT_PORT;

  await app.listen({ port: PORT, host: '0.0.0.0' });
  healthCheck.start();
  app.log.info(`MCP Hub Local running on http://localhost:${PORT}`);
  app.log.info(`  API:     http://localhost:${PORT}/api`);
  app.log.info(`  Web UI:  http://localhost:${PORT}/app`);
  app.log.info(`  MCP:     http://localhost:${PORT}/w/<workspaceSlug>`);
}

main().catch((err) => {
  console.error('Failed to start MCP Hub Local:', err);
  process.exit(1);
});
