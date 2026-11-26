import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Variable de entorno requerida: ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  clientOrigin: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  cookieName: 'rms_token',
  uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
  /** Cookie solo por HTTPS. Poner COOKIE_SECURE=false si se sirve por HTTP en red local. */
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : (process.env.NODE_ENV ?? 'development') === 'production',
  get isProd() {
    return this.env === 'production';
  },
};

if (config.isProd && config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET debe tener al menos 32 caracteres en producción');
}
