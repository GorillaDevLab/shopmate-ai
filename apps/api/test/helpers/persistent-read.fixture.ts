import type { PersistentReadBinder } from "../../src/integrations/mock/persistent-read-port.js";

/** Explicit empty publication fixture; runtime composition always requires the database binder. */
export const emptyPersistentBinder: PersistentReadBinder = {
  bind(_actor, scope) {
    return {
      async read(request) {
        const at =
          request.requestedUntil < request.businessNow
            ? request.requestedUntil
            : request.businessNow;
        return {
          publication: {
            scope,
            revision: "1",
            targetClockRevision: 0,
            targetTime: at,
            baseRevision: "0",
            baseHighEventSeq: "0",
            highEventSeq: "0",
            eventCount: "0",
            versionCount: "0",
            processedThrough: at,
            generatorVersion: "mock-source-v1",
            runtimeVersion: "mock-runtime-v2",
            codec: "source-snapshot-v1",
            publishedAt: at,
            certificateHash: "a".repeat(64),
          },
          items: [],
          nextCursor: null,
          effectiveUntil: at,
        };
      },
    };
  },
};
