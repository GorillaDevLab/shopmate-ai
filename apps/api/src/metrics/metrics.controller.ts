import { Controller, Get, Inject, Req } from "@nestjs/common";
import { MetricsQueryService, type MetricHttpRequest } from "./metrics-query.service.js";

@Controller({
  path: ["stores/:storeId/metrics", "workspaces/:workspaceId/stores/:storeId/metrics"],
  version: "1",
})
export class MetricsController {
  constructor(@Inject(MetricsQueryService) private readonly service: MetricsQueryService) {}

  @Get()
  read(@Req() request: MetricHttpRequest) {
    return this.service.read(request);
  }

  @Get("history")
  history(@Req() request: MetricHttpRequest) {
    return this.service.history(request);
  }
}
