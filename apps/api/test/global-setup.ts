/* eslint-disable @typescript-eslint/no-require-imports */
export default async function globalSetup(): Promise<void> {
  require('./setup-env');
  const { runMigrations } = require('../src/database/migrate');
  await runMigrations(process.env.DATABASE_URL as string, undefined, () => undefined);
}
