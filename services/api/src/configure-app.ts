import { INestApplication, VersioningType } from '@nestjs/common';

/** Shared by main.ts and the integration tests so tests exercise the real routing setup. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI });
}
