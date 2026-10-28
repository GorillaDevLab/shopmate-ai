import { Controller, Inject, Post, Req } from "@nestjs/common";
import {
  EVENT_LIFECYCLE_SERVICE,
  type EventLifecycleService,
  type LifecycleHttpRequest,
} from "./event-lifecycle.service.js";

/** Authentication is the existing global MerchantScopeGuard; module registration is P04-029. */
@Controller({
  path: [
    "stores/:storeId/events/:eventId",
    "workspaces/:workspaceId/stores/:storeId/events/:eventId",
  ],
  version: "1",
})
export class EventLifecycleController {
  constructor(
    @Inject(EVENT_LIFECYCLE_SERVICE)
    private readonly service: Pick<EventLifecycleService<never>, "execute">,
  ) {}
  @Post("acknowledge")
  acknowledge(@Req() request: LifecycleHttpRequest) {
    return this.service.execute("acknowledge", request);
  }
  @Post("resolve")
  resolve(@Req() request: LifecycleHttpRequest) {
    return this.service.execute("resolve", request);
  }
  @Post("suppress")
  suppress(@Req() request: LifecycleHttpRequest) {
    return this.service.execute("suppress", request);
  }
}
