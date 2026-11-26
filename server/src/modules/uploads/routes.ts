import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../../config';
import { ah } from '../../lib/asyncHandler';
import { requirePermission } from '../../middleware/auth';
import { badRequest } from '../../lib/errors';

const dir = path.resolve(config.uploadDir);
fs.mkdirSync(dir, { recursive: true });

const ALLOWED = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: dir,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ALLOWED.get(file.mimetype) ?? ''}`),
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED.has(file.mimetype)),
});

export const uploadsRouter = Router();

uploadsRouter.post(
  '/',
  requirePermission('menu.manage', 'settings.manage'),
  upload.single('file'),
  ah(async (req, res) => {
    if (!req.file) throw badRequest('Archivo inválido. Formatos permitidos: PNG, JPG, WEBP o GIF (máx. 3 MB)');
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  }),
);
