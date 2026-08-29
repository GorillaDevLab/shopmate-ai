import "reflect-metadata";
import { resolve } from "node:path";
import dotenv from "dotenv";

import { NestFactory } from "@nestjs/core";

import { configureApp } from "./app.config.js";
import { AppModule } from "./app.module.js";
import { readDeepSeekEnv } from "./config/deepseek-env.js";
import { resolvePort } from "./runtime/port.js";

dotenv.config({ path: resolve(process.cwd(), "../../.env") });

async function bootstrap(): Promise<void> {
  readDeepSeekEnv(process.env);
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(resolvePort(process.env.PORT));
}

await bootstrap();
