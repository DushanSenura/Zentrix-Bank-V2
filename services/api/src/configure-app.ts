import { INestApplication, VersioningType } from '@nestjs/common';
import helmet from 'helmet';

/** Shared by main.ts and the integration tests so tests exercise the real routing setup. */
export function configureApp(app: INestApplication): void {
  app.use(helmet()); // security headers on every response, in tests too
  app.getHttpAdapter().getInstance().disable?.('x-powered-by');
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI });
}
