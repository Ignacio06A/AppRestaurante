import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { config } from './config';
import { AppError } from './lib/errors';
import { authenticate } from './middleware/auth';
import { authRouter } from './modules/auth/routes';
import { usersRouter } from './modules/users/routes';
import { tablesRouter } from './modules/tables/routes';
import { menuRouter } from './modules/menu/routes';
import { ordersRouter } from './modules/orders/routes';
import { kdsRouter } from './modules/kds/routes';
import { notificationsRouter } from './modules/notifications/routes';
import { paymentsRouter } from './modules/payments/routes';
import { cashRouter } from './modules/cash/routes';
import { reportsRouter } from './modules/reports/routes';
import { settingsRouter } from './modules/settings/routes';
import { auditRouter } from './modules/audit/routes';
import { uploadsRouter } from './modules/uploads/routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'same-site' },
      contentSecurityPolicy: config.isProd
        ? { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'", 'ws:', 'wss:'], styleSrc: ["'self'", "'unsafe-inline'"] } }
        : false,
    }),
  );
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Protección CSRF básica: las mutaciones deben venir como JSON/multipart desde el mismo origen
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && !config.clientOrigin.includes(origin) && !origin.endsWith(`//${req.headers.host}`)) {
        return next(new AppError(403, 'Origen no permitido', 'FORBIDDEN_ORIGIN'));
      }
    }
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use('/api/auth', authRouter);

  // A partir de aquí todo requiere sesión válida
  app.use('/api', authenticate);
  app.use('/api/admin', usersRouter);
  app.use('/api/tables', tablesRouter);
  app.use('/api', menuRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/kds', kdsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/cashier', paymentsRouter);
  app.use('/api/cash', cashRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api', settingsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/uploads', uploadsRouter);

  app.use('/uploads', express.static(path.resolve(config.uploadDir), { maxAge: '7d' }));

  // En producción el backend sirve el frontend compilado
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|socket\.io|uploads).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'Ruta no encontrada', 'NOT_FOUND')));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Datos inválidos', details: err.issues } });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return res.status(409).json({ error: { code: 'CONFLICT', message: 'Registro duplicado' } });
      if (err.code === 'P2025') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Registro no encontrado' } });
      if (err.code === 'P2003') return res.status(409).json({ error: { code: 'CONFLICT', message: 'El registro está relacionado con otros datos' } });
    }
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'JSON inválido' } });
    }
    console.error(`[${req.method} ${req.originalUrl}]`, err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Error interno del servidor' } });
  });

  return app;
}
