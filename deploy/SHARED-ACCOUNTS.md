# Shared accounts operator runbook

This is proposed consumer source, not evidence of live activation. Parent coordinates the Space provider, accounts hostname, secrets, recovery and rollout. Do not let the consumer auto-deploy before those prerequisites are ready.

## Configuration and release gate

Required protected runtime environment:

```dotenv
OVERROOT_PUBLIC_URL=https://overroot.toni.foo
OVERROOT_IDENTITY_ORIGIN=https://accounts.toni.foo
OVERROOT_IDENTITY_BASE_URL=http://127.0.0.1:18746
```

Set `OVERROOT_IDENTITY_CLIENT_SECRET` privately, matching Space's confidential `overroot` client. Never pass it in argv or commit it. The fixed production callback is `https://overroot.toni.foo/api/v1/auth/callback`. An explicit HTTPS public origin and matching registered callback are required for other installations/test providers. Backchannel HTTP is allowed only to literal loopback; HTTPS is otherwise required. Requests carry the issuer Host, client key and no browser cookies, prohibit redirects, and time out after 3 seconds. Missing configuration prevents startup, with no password fallback.

Before publishing, the parent must hold the existing updater, verify the provider and accounts route, supply private config, review exact-head hosted CI/CodeQL, and arrange the stopped-service migration below. This branch does not change installed host automation. `/health` proves only process liveness, not provider connectivity or migration readiness. Parent must review the existing external uptime probe for this release.

## Explicit migration

The mapping file is operator-supplied JSON outside Git, mode 0600. Format is strict, versioned, and contains no email, nickname or password:

```json
{
  "version": 1,
  "mappings": [
    { "overroot_user_id": "EXACT_EXISTING_LOCAL_ID", "space_user_id": "EXACT_CONFIRMED_SPACE_ID" }
  ]
}
```

Include **every** existing Overroot user exactly once. Space IDs must also be unique. Anton's confirmed links must be supplied privately by the parent; none are embedded in source. Obtain local IDs with a read-only query of `users(id, username)` and central IDs from the authorized Space operator. Never infer a link from equal names or email addresses.

After review, with deploy/backup jobs held and the app stopped gracefully:

1. Take a fresh separate SQLite backup and verify recovery of documents, original PDF/source blobs, revisions, private memberships, local admin grants and agent credentials. Retain original UnderLeaf recovery and protect the pre-migration backup because it contains old password verifiers. Verify compile-cache artifacts separately; the migration checks database blobs, not external artifacts or off-host recovery.
2. Set `OVERROOT_DATA_DIR` to the intended data directory using the protected runtime environment. The target file is `overroot.sqlite3`. Run the reviewed command, never candidate code on DGX:

   ```bash
   pnpm accounts:migrate /private/confirmed-mapping.json /verified/backup/overroot.sqlite3
   ```

3. The command checks backup integrity and compares the current users, projects, memberships, file bytes/revisions, agent credentials, audit and compile records against that snapshot. It refuses the target as its own backup, incomplete/duplicate/unknown mappings, unexpected prior links, and repeat execution. With the database stopped, it atomically installs the links, empties local password verifiers, deletes old human sessions and invitations, and marks migration complete. Local IDs, project foreign keys, permissions, history and agent secrets are unchanged. Schema preparation alone never retires verifiers.
4. Start the reviewed consumer only after the provider/config are ready. Verify existing users' memberships/admin grants, non-elevation for new identities, scoped agent access, central sign-in, logout and password-change revocation. Resume the established updater only after the parent accepts the activation evidence.

Unmapped users block all new human sign-in rather than silently provisioning duplicates. A fresh empty database needs no legacy mapping; first central sign-in provisions an ordinary user, never an admin. Unknown approved subjects get unique opaque `account-<uuid>` Overroot handles for sharing, without inheriting similarly named users. Existing handles and display names remain unchanged. The account control shows the local handle.

There is no automatic rollback. Before restoring, stop the app and updater, preserve current data, verify schema compatibility, and restore the full pre-migration database plus needed artifacts. Old code cannot open schema version 3. Do not restore local-password auth as an outage workaround.

## Runtime semantics

Sign-in attempts are in-memory, capped at 1000, browser-bound and single-use, with 120-second expiry and S256 PKCE.

Start admission permits 12 requests per client IP in a rolling five-minute window, including replaced/completed attempts. The limiter retains at most 4096 IP buckets, prunes expired entries on admission, and clears during preClose; admission limits return 429 before creating a new state/verifier.

With `OVERROOT_TRUST_PROXY=true`, admission uses the closest forwarded client address, not an untrusted leftmost X-Forwarded-For value. The protected ingress must append/overwrite the real client address in that position; otherwise disable proxy trust and use the direct peer IP. Parent must verify this existing Cloudflare Tunnel boundary before activation. App restarts discard pending attempts and rate-limit history.

Callback exchange uses the confidential backchannel, creates a hashed-token local session referencing the central grant and returns a host-only `__Host-overroot_session` cookie, never a browser bearer token. The cookie is Secure, HttpOnly, SameSite=Lax, Path=/, with no Domain. Old localStorage human tokens are discarded by the frontend and never accepted by the API.

Malformed, missing, mismatched, replayed or expired callback state never exchanges a code: the callback clears the attempt cookie and redirects to the app sign-in screen with a static error and an explicit fresh-sign-in action. An approval wait longer than the attempt TTL requires that fresh action; no validation is relaxed. Provider exchange failures also redirect to a retry screen, without echoing codes/state or automatically retrying the exchange.

Every human API request introspects its grant through the async hook before synchronous authorization. Inactive/expired/mismatched grants deny access. Provider errors return visible 503 and preserve the local session for retry. Authorization headers, including invalid ones, always take precedence over cookies; agent scopes do not depend on the provider. Host isolation is exact and cookie-authenticated mutations require the exact app Origin.

Live human sockets revalidate both the central grant and project permission every 10 seconds. With the 3-second backchannel timeout, the target revocation/outage bound is 13 seconds under a responsive event loop. Known revoked grants close 1008; unreachable/rejecting/malformed providers close 1013 so clients can retry. No further collaboration messages are accepted once socket closing begins. Human upgrade tickets also revalidate before upgrade, even if issued before logout. The existing preClose sequence stops validation timers and closes sockets before compiler/collaboration/database teardown.

Local logout revokes its central app grant before clearing the cookie/session and closing local sockets; an outage visibly fails logout so it can be retried. Central logout and password changes are authority responsibilities and invalidate the grants checked by the consumer. Approval confers no Overroot memberships or admin privileges. Account controls open the central origin. No email delivery, recovery or MFA is introduced.

CI injects a mock provider; production has no bypass flag. Candidate tests/builds/installations are not run on DGX. Installed static TypeScript/lint analysis may run without importing candidate application modules or changed executable configs.
