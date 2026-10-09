# Mock source work discovery

The dedicated source worker exposes `listBuildScopes()` for a background scheduler.
It returns owned, frozen `{ actor: { grantId }, scope }` entries for grants available
to the current restricted database login, with the current connection generation.
The server derives every scope coordinate from stored grants and connections. A
scheduler never guesses generation zero or accepts tenant coordinates from a client.

Discovery checks current demo environment, grant status, worker principal membership
and workspace access. Revoked grants and foreign database logins yield no work;
unsafe elevated credentials fail with the existing sanitized storage error.
After reset, discovery yields the new generation and old initialization is denied.

Discovery is advisory and does not claim a lease, create a generation, or prove
source publication completeness. Every subsequent initialization, claim, hydration,
append and publication must still recheck the exact grant and current scope. A
concurrent revocation or reset can therefore invalidate an already discovered entry.
This port is absent from the application read-only facade; it does not grant DML.
