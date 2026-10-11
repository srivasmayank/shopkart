import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true }); // rawBody: needed for webhooks (Ch. 5)

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // drop fields not declared in the DTO
      forbidNonWhitelisted: true, // reject them: stops "mass assignment"
      transform: true, // turn JSON into DTO class instances
    }),
  );

  app.enableShutdownHooks(); // close DB connections cleanly on stop
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`🚀 ShopKart API running on http://localhost:${port}`);
}

bootstrap();

