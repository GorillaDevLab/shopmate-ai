import {
  BadRequestException,
  type INestApplication,
  ValidationPipe,
  VersioningType,
} from "@nestjs/common";

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix("api");
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: "1",
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      stopAtFirstError: true,
      validationError: { target: false, value: false },
      exceptionFactory: () =>
        new BadRequestException({
          statusCode: 400,
          error: "请求参数无效",
          message: "请求参数校验失败",
        }),
    }),
  );
}
