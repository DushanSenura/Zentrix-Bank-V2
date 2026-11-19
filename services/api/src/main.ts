import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { loadEnv } from './config/env';

async function bootstrap() {
  // Local development convenience: load the repo-root .env if present (real envs inject variables).
  try {
    process.loadEnvFile('../../.env');
  } catch {
    /* no .env file - rely on the process environment */
  }
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);

  app.use(helmet());
  app.enableCors({
    origin: env.API_CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
  });
  configureApp(app);
  app.enableShutdownHooks();

  if (env.APP_ENV !== 'production') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Zentrix Bank V2 API')
        .setDescription('Simulation platform - fictional data only.')
        .setVersion('2.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, doc);
  }

  await app.listen(env.API_PORT);
  console.log(`Zentrix API listening on :${env.API_PORT} (${env.APP_ENV})`);
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
