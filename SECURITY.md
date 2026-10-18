# Security policy

Report a vulnerability privately through GitHub Security Advisories for `DebelToni/Overroot`. Do not include real project documents or credentials in a report.

Supported code is the current `main` branch.

## Deployment boundaries

Overroot is designed for a small invite-only group, not anonymous public registration. Keep the server bound to loopback and expose it only through the dedicated Cloudflare Tunnel. Do not commit `.env`, runtime data, agent passwords, or backup snapshots.

Agent passwords are project-scoped and displayed once. Revoke a credential immediately if it may have leaked. Stop the server before restoring a database snapshot.
