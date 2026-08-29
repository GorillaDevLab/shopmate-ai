import { Injectable } from "@nestjs/common";

export interface HealthResponse {
  readonly status: "ok";
  readonly service: "shopmate-api";
  readonly message: "服务运行正常";
  readonly timestamp: string;
}

@Injectable()
export class HealthService {
  check(): HealthResponse {
    return {
      status: "ok",
      service: "shopmate-api",
      message: "服务运行正常",
      timestamp: new Date().toISOString(),
    };
  }
}
