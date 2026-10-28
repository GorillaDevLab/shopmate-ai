import { Controller, Get, Inject, Req } from "@nestjs/common";
import { EventQueryService, type EventHttpRequest } from "./event-query.service.js";

@Controller({
  path: ["stores/:storeId/events", "workspaces/:workspaceId/stores/:storeId/events"],
  version: "1",
})
export class EventsController {
  constructor(@Inject(EventQueryService) private readonly service: EventQueryService) {}

  @Get()
  list(@Req() request: EventHttpRequest) {
    return this.service.list(request);
  }

  @Get(":eventId")
  detail(@Req() request: EventHttpRequest) {
    return this.service.detail(request);
  }

  @Get(":eventId/history")
  history(@Req() request: EventHttpRequest) {
    return this.service.history(request);
  }

  @Get(":eventId/evidence/:evidenceId")
  evidence(@Req() request: EventHttpRequest) {
    return this.service.evidence(request);
  }
}
