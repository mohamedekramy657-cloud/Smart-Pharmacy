import { z } from 'zod';

/**
 * Environment configuration. Parsed once, validated strictly. In production, insecure defaults
 * are rejected so a misconfigured deployment fails fast instead of running unsafely.
 */
const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().default('postgres://pharma:pharma_dev_password@127.0.0.1:5432/pharma_dev'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  APP_SECRET: z.string().min(32).default('dev-only-insecure-app-secret-change-me-0123456789'),
  DATA_ENCRYPTION_KEY: z
    .string()
    .default('ZGV2LW9ubHktaW5zZWN1cmUta2V5LTMyLWJ5dGVzISE='), // 32 bytes, base64 — DEV ONLY
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  COOKIE_SECURE: bool.default(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_PARTITIONED: bool.default(false),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  ADMIN_MFA_REQUIRED: bool.default(false),
  WORKER_ENABLED: bool.default(true),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  METRICS_TOKEN: z.string().optional(),
  EMAIL_PROVIDER: z.enum(['none', 'dev-log']).default('dev-log'),
  SMS_PROVIDER: z.enum(['none', 'dev-log']).default('none'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  FINDER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  SWAGGER_ENABLED: bool.default(true),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (Buffer.from(cfg.DATA_ENCRYPTION_KEY, 'base64').length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes encoded as base64');
  }
  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (cfg.APP_SECRET.startsWith('dev-only')) problems.push('APP_SECRET must be set');
    if (cfg.DATA_ENCRYPTION_KEY === EnvSchema.shape.DATA_ENCRYPTION_KEY.parse(undefined)) {
      problems.push('DATA_ENCRYPTION_KEY must be set');
    }
    if (!cfg.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true');
    if (cfg.COOKIE_SAMESITE === 'none' && !cfg.COOKIE_SECURE) problems.push('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
    if (cfg.EMAIL_PROVIDER === 'dev-log' || cfg.SMS_PROVIDER === 'dev-log') {
      problems.push('dev-log notification providers are not allowed in production');
    }
    if (cfg.DATABASE_URL.includes('pharma_dev_password')) problems.push('DATABASE_URL uses the dev password');
    if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join('; ')}`);
  }
  return cfg;
}

export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: reset memoized configuration after mutating process.env. */
export function resetConfigForTests(): void {
  cached = undefined;
}
