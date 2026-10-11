import { SourceStorageError } from "./errors.js";
import { createMockSourceReader } from "./index.js";
import { decodeCompactLatest, decodeLatestCheckpoint } from "./latest-cursor-codec.js";
import { fixedPortControl } from "./read-port-control.js";
import { checkedReadRequest, latestReadInput } from "./read-port-validation.js";
import type {
  BoundSourceReadPort,
  SourceReadPorts,
  SourceReadPage,
  SourceReadRequest,
} from "./read-port-types.js";
import { validateScanKey } from "./scan-cursor.js";
import type {
  MockSourceReader,
  SourceEnvironment,
  SourceReadActor,
  SourceReadControl,
  SourceScope,
} from "./types.js";
import { validateReadActor, validateScope } from "./validation.js";

async function readBound(
  reader: MockSourceReader,
  key: string,
  actor: SourceReadActor,
  scope: SourceScope,
  request: SourceReadRequest,
  control?: SourceReadControl,
): Promise<SourceReadPage | null> {
  const cutoff =
    request.requestedUntil < request.businessNow ? request.requestedUntil : request.businessNow;
  const until = request.cursor ? decodeCompactLatest(key, request.cursor, Date.now()).t : cutoff;
  if (until > cutoff) throw new SourceStorageError("SOURCE_INPUT");
  const input = latestReadInput(request, until);
  const fixedControl = fixedPortControl(control);
  if (!request.cursor) {
    const publication = await reader.findPublication(actor, scope, fixedControl);
    if (!publication || publication.targetTime < until) return null;
    const { revision, highEventSeq, certificateHash } = publication;
    const page = await reader.readLatestStates(
      actor,
      scope,
      { ...input, publication: { revision, highEventSeq, certificateHash } },
      fixedControl,
    );
    return page ? { ...page, effectiveUntil: until } : null;
  }
  const page = await reader.readLatestStates(actor, scope, input, fixedControl);
  return page ? { ...page, effectiveUntil: until } : null;
}

async function refreshBound(
  reader: MockSourceReader,
  key: string,
  actor: SourceReadActor,
  scope: SourceScope,
  request: SourceReadRequest,
  control?: SourceReadControl,
): Promise<string | null> {
  if (!request.cursor) throw new SourceStorageError("SOURCE_INPUT");
  const until = decodeLatestCheckpoint(key, request.cursor, Date.now()).t;
  if (until > request.requestedUntil || until > request.businessNow)
    throw new SourceStorageError("SOURCE_INPUT");
  return reader.refreshLatestCheckpoint(
    actor,
    scope,
    latestReadInput(request, until),
    fixedPortControl(control),
  );
}

export function bindSourceReadPort(
  reader: MockSourceReader,
  key: string,
  actor: SourceReadActor,
  scope: SourceScope,
  available: () => boolean = () => true,
): BoundSourceReadPort {
  validateReadActor(actor);
  validateScope(scope);
  const fixedActor = Object.freeze({ ...actor }),
    fixedScope = Object.freeze({ ...scope });
  return Object.freeze({
    async findPublication(control?: SourceReadControl) {
      if (!available()) throw new SourceStorageError("SOURCE_STORAGE");
      return reader.findPublication(fixedActor, fixedScope, fixedPortControl(control));
    },
    async refreshCheckpoint(input: unknown, control?: SourceReadControl) {
      if (!available()) throw new SourceStorageError("SOURCE_STORAGE");
      return refreshBound(reader, key, fixedActor, fixedScope, checkedReadRequest(input), control);
    },
    async read(input: unknown, control?: SourceReadControl) {
      if (!available()) throw new SourceStorageError("SOURCE_STORAGE");
      return readBound(reader, key, fixedActor, fixedScope, checkedReadRequest(input), control);
    },
  });
}

export function createMockSourceReadPorts(env: SourceEnvironment): SourceReadPorts {
  const key = env.MOCK_SOURCE_CURSOR_KEY ?? "";
  validateScanKey(key);
  const reader = createMockSourceReader(env);
  let closed = false;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    bind(actor: SourceReadActor, scope: SourceScope) {
      if (closed) throw new SourceStorageError("SOURCE_STORAGE");
      return bindSourceReadPort(reader, key, actor, scope, () => !closed);
    },
    close() {
      if (!closing) {
        closed = true;
        closing = reader.close();
      }
      return closing;
    },
  });
}
