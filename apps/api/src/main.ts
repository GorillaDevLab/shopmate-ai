import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { configureApp } from "./app.config.js";
import { AppModule } from "./app.module.js";
import { readDeepSeekEnv } from "./config/deepseek-env.js";
import { resolvePort } from "./runtime/port.js";

async function bootstrap(): Promise<void> {
  readDeepSeekEnv(process.env);
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(resolvePort(process.env.PORT));
}

await bootstrap();
