import { Module } from "@nestjs/common";

import { DashboardLayoutController } from "./dashboard-layout.controller.js";
import {
  DASHBOARD_LAYOUT_REPOSITORY,
  PrismaDashboardLayoutRepository,
} from "./dashboard-layout.repository.js";
import { DashboardLayoutService } from "./dashboard-layout.service.js";

@Module({
  controllers: [DashboardLayoutController],
  providers: [
    DashboardLayoutService,
    PrismaDashboardLayoutRepository,
    { provide: DASHBOARD_LAYOUT_REPOSITORY, useExisting: PrismaDashboardLayoutRepository },
  ],
  exports: [DashboardLayoutService],
})
export class DashboardLayoutModule {}
