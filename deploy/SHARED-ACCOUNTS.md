# Site-owned accounts consumer runbook

This is proposed consumer source, not evidence of live activation. Parent coordinates the site-owned authority, private administration, accounts hostname, secrets, recovery and rollout. Authority source is `~/tonifoo/accounts/`; the site integration contract is `~/tonifoo/docs/ACCOUNTS.md`. Space and Overroot are consumers. The staged ef15999 release has the proven Host transport bug and MUST NOT activate; this candidate requires new exact-head hosted CI/review/merge and a rebuilt stage. Do not let the consumer auto-deploy before those prerequisites are ready.

## Configuration and release gate

Required protected runtime environment:

```dotenv
OVERROOT_PUBLIC_URL=https://overroot.toni.foo
OVERROOT_IDENTITY_ORIGIN=https://accounts.toni.foo
OVERROOT_IDENTITY_BASE_URL=http://127.0.0.1:18760
```

Set `OVERROOT_IDENTITY_CLIENT_SECRET` privately with at least 32 characters, matching the site authority's confidential `overroot` client. Never pass it in argv or commit it. The fixed production callback is `https://overroot.toni.foo/api/v1/auth/callback`. An explicit HTTPS public origin and matching registered callback are required for other installations/test providers. Backchannel HTTP is allowed only to literal loopback; HTTPS is otherwise required. Native `node:http`/`node:https.request` carries the issuer Host, client key and JSON body without browser cookies, rejects redirects/non-200 responses, bounds headers/body to 16 KiB, and applies an absolute 3-second timeout including stalled response bodies. The base URL is required explicitly; no silent WAN fallback is provided. Missing configuration or a client secret shorter than 32 characters prevents startup, with no password fallback.

Before merging or activating the consumer, the parent must hold the existing updater, verify the provider and accounts route, supply private config, review exact-head hosted CI/CodeQL, and arrange the stopped-service migration below. This branch does not change installed host automation. `/health` proves only process liveness, not provider connectivity or migration readiness. Parent must review the existing external uptime probe for this release.

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

Include **every** existing Overroot user exactly once. Canonical site account subject IDs must also be unique. The mapping key `space_user_id` is retained because the offline site import preserves the exact canonical Space IDs; its value is now the immutable site account subject, not a Space-owned credential or inferred profile match. Anton's confirmed links must be supplied privately by the parent; none are embedded in source. Obtain local IDs with a read-only query of `users(id, username)` and central IDs from the authorized site account operator. Never infer a link from equal names or email addresses.

After review, with deploy/backup jobs held and the app stopped gracefully:

1. Take a fresh separate SQLite backup and verify recovery of documents, original PDF/source blobs, revisions, private memberships, local admin grants and agent credentials. Retain original UnderLeaf recovery and protect the pre-migration backup because it contains old password verifiers. Verify compile-cache artifacts separately; the migration checks database blobs, not external artifacts or off-host recovery.
2. Set `OVERROOT_DATA_DIR` to the intended data directory using the protected runtime environment. The target file is `overroot.sqlite3`. Run the reviewed command, never candidate code on DGX:

   ```bash
   pnpm accounts:migrate /private/confirmed-mapping.json /verified/backup/overroot.sqlite3
   ```

3. The command checks backup integrity and compares the current users, projects, memberships, file bytes/revisions, agent credentials, audit and compile records against that snapshot. It refuses the target as its own backup, incomplete/duplicate/unknown mappings, unexpected prior links, and repeat execution. With the database stopped, it atomically installs the links, empties local password verifiers, deletes old human sessions and invitations, and marks migration complete. Local IDs, project foreign keys, permissions, history and agent secrets are unchanged. Schema preparation alone never retires verifiers.
4. Start the reviewed consumer only after the provider/config are ready. Verify existing users' memberships and preserved Admin-button flag, non-elevation for new identities, scoped agent access, central sign-in, logout and password-change revocation. Resume the established updater only after the parent accepts the activation evidence.

Unmapped users block all new human sign-in rather than silently provisioning duplicates. A fresh empty database needs no legacy mapping; first central sign-in provisions an ordinary user, never an admin. Unknown service-admitted subjects get unique opaque `account-<uuid>` Overroot handles for sharing, without inheriting similarly named users. Existing handles and display names remain unchanged. The account control shows the local handle.

There is no automatic rollback. Before restoring, stop the app and updater, preserve current data, verify schema compatibility, and restore the full pre-migration database plus needed artifacts. Old code cannot open schema version 3. Do not restore local-password auth as an outage workaround.

## Private-only local account information

The existing local `is_admin` flag is preserved solely for the **Admin** navigation affordance. `/api/v1/auth/admin` requires a valid human service grant and that flag, then redirects only to the public issuer's `/admin`. The issuer independently checks its configured owner and redirects to its private origin; no private administration URL is compiled into Overroot or supplied by a browser. Public account-admin endpoints such as `/api/v1/admin/users` are absent even for the owner. Normal project sharing and its user search remain app content features.

The site private-admin server may fetch `GET /api/internal/admin/users` over loopback with exact `Host: overroot.admin.internal` (no port suffix) and `X-Accounts-Client-Key` equal to Overroot's configured service secret. Authorization uses the actual raw socket peer, never Fastify's forwarded `request.ip`; only IPv4 loopback, IPv6 loopback and IPv4-mapped loopback peers qualify. Duplicate Host/key headers and public Hosts are denied regardless of owner cookies/key. The client-key comparison hashes both inputs to equal-length digests and compares them with the installed timing-safe helper. All other API routes require the exact public app Host, including preflights.

The response is `{users:[{id,subject,username,displayName,isAdmin,createdAt}]}`, with null subject for unmapped legacy rows. `isAdmin` is local history/button information, not central service policy. This read-only adapter never returns password hashes, cookies/tokens, grant references or private project content, and sets no-store. It does not itself introspect a browser grant: the site private server must validate its owner-bound private session before proxying this fixed adapter. Do not expose this Host through public ingress or a browser-supplied target URL. Parent owns private adapter configuration, tailnet routing and probes; no host changes are installed by this source.

## Runtime semantics

Sign-in attempts are in-memory, capped at 1000, browser-bound and single-use, with 120-second expiry and S256 PKCE.

Start admission permits 12 requests per client IP in a rolling five-minute window, including replaced/completed attempts. The limiter retains at most 4096 IP buckets, prunes expired entries on admission, and clears during preClose; admission limits return 429 before creating a new state/verifier.

With `OVERROOT_TRUST_PROXY=true`, admission uses the closest forwarded client address, not an untrusted leftmost X-Forwarded-For value. The protected ingress must append/overwrite the real client address in that position; otherwise disable proxy trust and use the direct peer IP. Parent must verify this existing Cloudflare Tunnel boundary before activation. App restarts discard pending attempts and rate-limit history.

Unauthenticated project navigation retains its route, query and fragment in React Router state; the sign-in link passes only a validated app-local `returnTo` to auth/start. The default sign-in link is unchanged. Callback exchange uses the confidential backchannel, creates a hashed-token local session referencing the central grant and returns a host-only `__Host-overroot_session` cookie, never a browser bearer token. The cookie is Secure, HttpOnly, SameSite=Lax, Path=/, with no Domain. Old localStorage human tokens are discarded by the frontend and never accepted by the API.

Malformed, missing, mismatched, replayed or expired callback state never exchanges a code: the callback clears the attempt cookie and redirects to the app sign-in screen with a static error and an explicit fresh-sign-in action. A service approval wait longer than the attempt TTL requires that fresh action; no validation is relaxed. Provider exchange failures also redirect to a retry screen, without echoing codes/state or automatically retrying the exchange.

Every human API request introspects its grant through the async hook before synchronous authorization. Token/active-introspection responses must contain `service_id: "overroot"`, a nonempty role of at most 64 characters, at most 64 permission strings of 1–64 characters, and an approved user (bounded subject, email and nickname). `approved: true` means service admission on this wire, not account-wide approval. Inactive/expired/subject-mismatched grants or missing live permission `use` deny access. Registered central roles/extra permissions are not mapped onto content permissions or the local Admin-button flag. Provider errors return visible 503 and preserve the local session for retry. Authorization headers, including invalid ones, always take precedence over cookies; agent scopes do not depend on the provider. Host isolation is exact and cookie-authenticated mutations require the exact app Origin.

Live human sockets revalidate both the central grant and project permission every 10 seconds. With the 3-second backchannel timeout, the target revocation/outage bound is 13 seconds under a responsive event loop. Known revoked grants close 1008; unreachable/rejecting/malformed providers close 1013 so clients can retry. No further collaboration messages are accepted once socket closing begins. Human upgrade tickets also revalidate before upgrade, even if issued before logout. The existing preClose sequence stops validation timers and closes sockets before compiler/collaboration/database teardown.

Local logout revokes its central app grant before clearing the cookie/session and closing local sockets; an outage visibly fails logout so it can be retried. Central logout and password changes are authority responsibilities and invalidate the grants checked by the consumer. Account controls open the central origin. No email delivery, recovery or MFA is introduced.

Hosted CI injects v2 service-grant fixtures and uses a real local HTTP capture server for transport/Host/timeout regressions, plus raw-socket internal-directory checks; production has no bypass flag. Candidate tests/builds/installations are not run on DGX. Installed static TypeScript/lint analysis may run without importing candidate application modules or changed executable configs.
