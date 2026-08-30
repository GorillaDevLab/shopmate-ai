import { Controller, Get, Inject } from "@nestjs/common";

import { Public } from "../auth/access/public.decorator.js";
import { HealthService, type HealthResponse } from "./health.service.js";

@Controller({ path: "health", version: "1" })
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  @Public()
  check(): HealthResponse {
    return this.healthService.check();
  }
}
