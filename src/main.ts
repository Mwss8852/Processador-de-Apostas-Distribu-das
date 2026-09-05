import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { loadEnv } from '@config/env';
import { createLogger } from '@shared/observability/logger';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useLogger(createLogger('http-api'));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  const shutdown = async (signal: string) => {
    // Encerramento gracioso: NestJS aciona onModuleDestroy (fecha a conexão
    // com o Postgres) antes de finalizar o processo. Requisições em voo
    // continuam até o próprio Node liberar o listener HTTP.
    // eslint-disable-next-line no-console
    console.log(`[http-api] received ${signal}, shutting down gracefully`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(env.port);
}

bootstrap();
