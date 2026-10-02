import { ConnectorTimestampSchema } from "@shopmate/contracts";

export interface BusinessTime {
  readonly now: string;
  readonly revision: number;
}

/** Business time never controls session, approval, signature or lease expiry. */
export interface BusinessClock {
  snapshot(): BusinessTime;
}

export class RealBusinessClock implements BusinessClock {
  snapshot(): BusinessTime {
    return Object.freeze({ now: new Date().toISOString(), revision: 0 });
  }
}

export class SimulationClock implements BusinessClock {
  private milliseconds: number;
  private revision = 0;

  constructor(now: unknown) {
    this.milliseconds = Date.parse(ConnectorTimestampSchema.parse(now));
    ConnectorTimestampSchema.parse(new Date(this.milliseconds).toISOString());
  }

  snapshot(): BusinessTime {
    return Object.freeze({
      now: new Date(this.milliseconds).toISOString(),
      revision: this.revision,
    });
  }

  advance(durationMs: number): BusinessTime {
    const next = this.milliseconds + durationMs;
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs < 0 ||
      !Number.isFinite(next) ||
      Math.abs(next) > 8_640_000_000_000_000 ||
      !Number.isSafeInteger(this.revision + 1)
    ) {
      throw new RangeError("Invalid business clock advance");
    }
    if (durationMs > 0) {
      ConnectorTimestampSchema.parse(new Date(next).toISOString());
      this.milliseconds = next;
      this.revision += 1;
    }
    return this.snapshot();
  }
}
