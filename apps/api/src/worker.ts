import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { JobsService } from './modules/jobs/jobs.service';

/** Standalone background worker (run with WORKER_ENABLED=false on API instances when scaling out). */
async function main(): Promise<void> {
  const ctx = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  ctx.useLogger(ctx.get(Logger));
  ctx.enableShutdownHooks();
  ctx.get(JobsService).start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
