# Security policy

Report a vulnerability privately through GitHub Security Advisories for `DebelToni/Overroot`. Do not include real project documents or credentials in a report.

Supported code is the current `main` branch.

## Deployment boundaries

Overroot is designed for a small invite-only group, not anonymous public registration. Keep the server bound to loopback and expose it only through the dedicated Cloudflare Tunnel. Do not commit `.env`, runtime data, agent passwords, or backup snapshots.

Production builds and the app currently run as the DGX owner's account. Docker isolation applies only to LaTeX, not the application or deployment builds. A malicious merged change can access that account's files and Docker privileges. PR-only main, owner-only merging, exact-revision review and CI are a trust gate, not an operating-system sandbox. AI review can miss malicious code or prompt injection; a dedicated VM without owner credentials or the host Docker socket is needed for a stronger boundary. See [review policy](deploy/REVIEW.md).

Agent passwords are project-scoped and displayed once. Revoke a credential immediately if it may have leaked. Stop the server before restoring a database snapshot.
