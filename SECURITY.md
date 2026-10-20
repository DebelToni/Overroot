# Security policy

Report a vulnerability privately through GitHub Security Advisories for `DebelToni/Overroot`. Do not include real project documents or credentials in a report.

Supported code is the current `main` branch.

## Deployment boundaries

Site-owned accounts permit immediate public signup, with separately requested/approved service access and registered roles. Overroot project access remains explicit and private. Human credentials are handled only by the site-owned authority at `accounts.toni.foo`; Overroot has no local-password fallback. Keep the server bound to loopback and expose it only through the dedicated Cloudflare Tunnel. Do not commit `.env`, runtime data, agent passwords, or backup snapshots.

Production builds and the app currently run as the DGX owner's account. Docker isolation applies only to LaTeX, not the application or deployment builds. A malicious merged change can access that account's files and Docker privileges. PR-only main, owner-only merging, exact-revision review and CI are a trust gate, not an operating-system sandbox. AI review can miss malicious code or prompt injection; a dedicated VM without owner credentials or the host Docker socket is needed for a stronger boundary. See [review policy](deploy/REVIEW.md).

Agent passwords are project-scoped and displayed once. Revoke a credential immediately if it may have leaked. Stop the server before restoring a database snapshot.

Shared account configuration, migration and revocation limits are documented in [the operator runbook](deploy/SHARED-ACCOUNTS.md). App cookies are host-only, Secure, HttpOnly and SameSite=Lax. Every cookie-authenticated mutation requires the exact app Origin; agent Authorization headers take precedence and retain independent project scope.

Public account-admin APIs are unavailable, even for the owner. The legacy local admin flag controls only an issuer-admin navigation button. Read-only local-directory access is restricted to actual loopback peers, exact Host `overroot.admin.internal`, and the confidential service client key; forwarded IP/Host headers and human cookies cannot authorize it. Every human grant must identify service `overroot` and retain permission `use`; central roles do not alter project ACLs.
