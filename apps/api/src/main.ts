import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { hashIp } from './common/crypto';
import { GlobalExceptionFilter } from './common/errors';
import { requestContext } from './common/request-context';
import { config } from './config/config';
import { JobsService } from './modules/jobs/jobs.service';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const cfg = config();
  const app = await NestFactory.create(AppModule, { bodyParser: false, bufferLogs: true, logger: opts.logger === false ? false : undefined });
  if (opts.logger !== false) app.useLogger(app.get(Logger));
  const http = app.getHttpAdapter().getInstance() as express.Express;
  http.set('trust proxy', cfg.TRUST_PROXY_HOPS);
  http.disable('x-powered-by');

  // Correlated request id + privacy-preserving IP hash for every request.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    requestContext.run({ requestId, ipHash: hashIp(req.ip), userAgent: req.headers['user-agent']?.slice(0, 200) }, () => next());
  });

  const strict = helmet({ contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'same-origin' }, frameguard: { action: 'deny' } });
  const docs = helmet({ contentSecurityPolicy: false });
  app.use((req: Request, res: Response, next: NextFunction) => (req.path.startsWith('/api/docs') ? docs(req, res, next) : strict(req, res, next)));
  app.use((_req: Request, res: Response, next: NextFunction) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // JSON-only API: rejecting other content types blocks HTML-form CSRF vectors (defense in depth).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (MUTATING.has(req.method) && hasBody && !req.is('application/json')) {
      res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Request body must be application/json' } });
      return;
    }
    next();
  });
  app.use(express.json({
    limit: '1mb',
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      if (req.url.startsWith('/api/v1/integrations/webhooks/')) req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(cookieParser());

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

  if (cfg.SWAGGER_ENABLED) {
    const doc = SwaggerModule.createDocument(app, buildOpenApiConfig());
    SwaggerModule.setup('api/docs', app, doc, { jsonDocumentUrl: 'api/docs/openapi.json' });
  }
  return app;
}

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('Smart Pharmacy Ecosystem API')
    .setDescription('REST API for pharmacies, warehouses, patients and administrators. Cookie session auth; state-changing requests require the X-CSRF-Token header. Errors use { error: { code, message, details, requestId } }.')
    .setVersion('1.0.0')
    .addCookieAuth('sp_session')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrf')
    .build();
}

async function bootstrap(): Promise<void> {
  const cfg = config();
  const app = await createApp();
  await app.listen(cfg.API_PORT, cfg.API_HOST);
  if (cfg.WORKER_ENABLED) app.get(JobsService).start();
  app.get(Logger).log(`API listening on http://${cfg.API_HOST}:${cfg.API_PORT}/api (worker ${cfg.WORKER_ENABLED ? 'enabled' : 'disabled'})`);
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
