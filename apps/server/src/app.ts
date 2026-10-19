import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { AuthService } from './auth.js';
import { CollaborationManager, EventHub } from './collaboration.js';
import { Compiler } from './compiler.js';
import { config } from './config.js';
import type { AppContext } from './context.js';
import { Database } from './database.js';
import { HttpError } from './errors.js';
import { openapi } from './openapi.js';
import { ProjectStore } from './project-store.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerFileRoutes } from './routes/file-routes.js';
import { registerProjectRoutes } from './routes/project-routes.js';
import { registerRuntimeRoutes } from './routes/runtime-routes.js';
import { TicketStore, WebSocketGateway } from './websockets.js';

export interface BuildAppOptions {
  databasePath?: string;
  dataDir?: string;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.query.ticket', 'res.headers.authorization']
    },
    trustProxy: config.trustProxy,
    bodyLimit: 30 * 1024 * 1024,
    requestIdHeader: 'x-request-id'
  });

  const db = new Database(options.databasePath);
  const auth = new AuthService(db);
  const projects = new ProjectStore(db);
  const events = new EventHub();
  const collaboration = new CollaborationManager(projects, events);
  const appDataDir = options.dataDir ?? (options.databasePath ? dirname(options.databasePath) : config.dataDir);
  const compiler = new Compiler(db, projects, collaboration, events, appDataDir);
  const tickets = new TicketStore();
  const gateway = new WebSocketGateway(app.server, tickets, collaboration, events);
  const context: AppContext = { db, auth, projects, events, collaboration, compiler, tickets, gateway };

  await compiler.initialize();
  auth.cleanup();

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: 'Invalid request', details: error.issues }
      });
    }
    if (error instanceof Error && error.message === 'Origin is not allowed') {
      return reply.code(403).send({ error: { code: 'origin_denied', message: error.message } });
    }
    request.log.error(error);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error('Origin is not allowed'), false);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'X-Request-Id'],
    exposedHeaders: ['ETag', 'X-Compile-Job', 'Content-Disposition'],
    maxAge: 86_400
  });
  await app.register(multipart, {
    limits: { files: 1, fileSize: 25 * 1024 * 1024, fields: 10 }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return payload;
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/v1/openapi.json', async () => openapi);
  app.get('/api/openapi.json', async () => openapi);
  app.get('/api/v1/agent-guide.md', async (_request, reply) => {
    const path = join(config.webDist, 'agent-guide.md');
    if (!existsSync(path)) return reply.type('text/markdown').send(DEFAULT_AGENT_GUIDE);
    return reply.type('text/markdown').send(await readFile(path, 'utf8'));
  });

  registerAuthRoutes(app, context);
  registerProjectRoutes(app, context);
  registerFileRoutes(app, context);
  registerRuntimeRoutes(app, context);

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Endpoint not found' } });
    }
    const index = join(config.webDist, 'index.html');
    if (existsSync(index)) return reply.type('text/html').send(await readFile(index));
    return reply.send({ name: 'Overroot', api: '/api/v1/openapi.json' });
  });

  // Upgraded sockets keep HTTP server.close() pending. Close them before that
  // drain starts, so the final compiler/collaboration/database hooks can run.
  app.addHook('preClose', async () => {
    await gateway.close();
  });

  app.addHook('onClose', async () => {
    await compiler.close();
    await collaboration.close();
    db.checkpoint();
    db.close();
  });

  return { app, context, gateway };
}

const DEFAULT_AGENT_GUIDE = `# Overroot agent API\n\nFetch the OpenAPI document from \`/api/v1/openapi.json\`. Authenticate with \`Authorization: Bearer <agent-password>\`.\n`;
