import { SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { buildOpenApiConfig, createApp } from './main';

/** Generates docs/openapi.json from the running route definitions (no server is started). */
async function main(): Promise<void> {
  process.env.LOG_LEVEL = 'silent';
  const app = await createApp({ logger: false });
  await app.init();
  const doc = SwaggerModule.createDocument(app, buildOpenApiConfig());
  const out = resolve(process.cwd(), process.argv[2] ?? '../../docs/openapi.json');
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`OpenAPI written to ${out} (${Object.keys(doc.paths).length} paths)`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
