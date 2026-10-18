# Contributing

1. Create a branch from `main`.
2. Keep changes focused and include tests for behavior changes.
3. Run `pnpm check && pnpm test:compiler`.
4. Open a pull request targeting `main`, describing the user-visible result and security implications.

Direct pushes to `main` are blocked, including the owner's. Both CI and CodeQL must pass on an up-to-date PR. Only the owner/admin can merge after review; contributors cannot approve each other's changes into production. New PR revisions are routed to the owner's existing Pi session. No deployment credentials or host access are needed for contributors. See [review policy](deploy/REVIEW.md).

Node.js 24+, pnpm 10.27, uv, and Docker for the compiler regression test are required. Never commit `data/`, `.env`, generated credentials, or backup snapshots. Contributions are licensed under AGPL-3.0-only.
