// Test environment: isolated database, no background worker, silent logs, generous rate limits
// (individual tests lower limits explicitly when testing throttling).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://pharma:pharma_dev_password@127.0.0.1:5432/pharma_test';
process.env.LOG_LEVEL = 'silent';
process.env.WORKER_ENABLED = 'false';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100000';
process.env.FINDER_RATE_LIMIT_PER_MINUTE = '100000';
process.env.SWAGGER_ENABLED = 'false';
process.env.EMAIL_PROVIDER = 'dev-log';
process.env.SMS_PROVIDER = 'none';
process.env.ADMIN_MFA_REQUIRED = 'false';
