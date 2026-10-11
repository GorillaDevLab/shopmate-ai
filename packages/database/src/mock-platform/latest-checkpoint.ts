import type pg from "pg";
import type { SourcePool } from "./clients.js";
import { SourceAccessDenied, SourceStorageError } from "./errors.js";
import { readTransaction } from "./read-transaction.js";
import {
  createLatestCursor,
  readLatestCheckpoint,
  type LatestCursorState,
} from "./latest-cursor.js";
import { assertLatestPublication } from "./latest-publication.js";
import { restoreLatestPosition } from "./latest-witness.js";
import { readPublication } from "./publication-certificate.js";
import { currentAccess, lockControl, readIdentity } from "./transaction.js";
import type { LatestStateInput } from "./latest-types.js";
import type { SourceReadActor, SourceReadControl, SourceScope } from "./types.js";

async function refresh(
  client: pg.PoolClient,
  key: string,
  actor: SourceReadActor,
  scope: SourceScope,
  input: LatestStateInput,
  state: LatestCursorState,
): Promise<string | null> {
  await lockControl(client, scope);
  await readIdentity(client, actor);
  if (!(await currentAccess(client, scope, "reader"))) return null;
  const publication = await readPublication(client, scope, state.revision);
  if (!publication) {
    if (!(await currentAccess(client, scope, "reader"))) throw new SourceAccessDenied();
    throw new SourceStorageError("SOURCE_INTEGRITY");
  }
  assertLatestPublication(state, publication, input);
  const position = await restoreLatestPosition(client, scope, publication, state, input);
  if (!(await currentAccess(client, scope, "reader"))) throw new SourceAccessDenied();
  return createLatestCursor(key, scope, publication, input, position, Date.now() + 15 * 60_000);
}
export async function refreshLatestCheckpoint(
  pool: SourcePool,
  key: string,
  actor: SourceReadActor,
  scope: SourceScope,
  input: LatestStateInput,
  control?: SourceReadControl,
): Promise<string | null> {
  if (input.cursor === undefined) throw new SourceStorageError("SOURCE_INPUT");
  const state = readLatestCheckpoint(key, input.cursor, scope, input);
  try {
    return await readTransaction(
      pool,
      (client) => refresh(client, key, actor, scope, input, state),
      (result) => result === null,
      control,
    );
  } catch (error) {
    if (error instanceof SourceAccessDenied) return null;
    throw error;
  }
}
