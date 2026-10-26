import { config } from '../config/config';
import { runMigrations } from './migrate';

runMigrations(config().DATABASE_URL)
  .then((r) => {
    console.log(`migrations complete: ${r.applied.length} applied, ${r.skipped.length} already applied`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
