import { Inject, Injectable } from "@nestjs/common";

import type { AuthContext } from "../auth/contracts/index.js";
import {
  SALES_QUERY_REPOSITORY,
  type SalesOrderRecord,
  type SalesQueryRepository,
} from "./sales-query.repository.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export interface SalesQueryInput {
  readonly startDate: string;
  readonly endDate: string;
}

@Injectable()
export class SalesQueryService {
  constructor(
    @Inject(SALES_QUERY_REPOSITORY)
    private readonly repository: SalesQueryRepository,
  ) {}

  async listEffectiveOrders(
    context: AuthContext,
    input: SalesQueryInput,
  ): Promise<readonly SalesOrderRecord[]> {
    const startDayUtc = parseDateOnly(input.startDate);
    const endDayUtc = parseDateOnly(input.endDate);

    if (startDayUtc > endDayUtc) {
      throw new RangeError("startDate must be earlier than or equal to endDate");
    }

    const startInclusive = new Date(startDayUtc - SHANGHAI_UTC_OFFSET_MS);

    const endExclusive = new Date(endDayUtc + MILLISECONDS_PER_DAY - SHANGHAI_UTC_OFFSET_MS);

    return this.repository.listEffectiveOrders(context, {
      startInclusive,
      endExclusive,
    });
  }
}

function parseDateOnly(value: string): number {
  const match = DATE_PATTERN.exec(value);

  if (!match) {
    throw new RangeError("date must use YYYY-MM-DD format");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const timestamp = Date.UTC(year, month - 1, day);

  const parsed = new Date(timestamp);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError("date is not a valid calendar date");
  }

  return timestamp;
}
