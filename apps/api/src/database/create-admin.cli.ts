import * as argon2 from 'argon2';
import { config } from '../config/config';
import { Database } from './db';

/**
 * Provision a platform super-administrator (there is intentionally no API for this).
 * Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_NAME=... node dist/src/database/create-admin.cli.js
 */
async function main(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? '';
  const name = process.env.ADMIN_NAME ?? 'Platform Administrator';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('ADMIN_EMAIL is required');
  if (password.length < 14 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error('ADMIN_PASSWORD must be at least 14 characters with letters and digits');
  const db = new Database(config().DATABASE_URL, 2);
  try {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const row = await db.one<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, platform_role) VALUES ($1,$2,$3,'SUPER_ADMIN')
       ON CONFLICT (email) DO UPDATE SET platform_role = 'SUPER_ADMIN', password_hash = EXCLUDED.password_hash RETURNING id`, [email, hash, name]);
    await db.exec(`INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [row.id]);
    await db.exec(`INSERT INTO audit_logs (actor_type, action, entity_type, entity_id, summary) VALUES ('SYSTEM','ADMIN_PROVISIONED','user',$1,'via CLI')`, [row.id]);
    console.log(`super admin ready: ${email} (enable MFA after first login)`);
  } finally {
    await db.close();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
