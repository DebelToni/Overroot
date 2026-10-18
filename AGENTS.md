# Overroot

Collaborative LaTeX studio. Public frontend, API and WebSockets: `https://overroot.toni.foo`, served together by Node on DGX. Docker is used only for Tectonic isolation. No GitHub Pages, discovery JSON or rotating tunnel publisher remains.

- Read `deploy/README.md` before deployment or data work. Production uses immutable releases under `~/.local/state/overroot/`, not this development checkout. Never run a second server against the production database.
- Runtime config and connector token live in `~/.config/overroot/`; data and backups are outside Git. Preserve original UnderLeaf recovery material at `~/.local/state/underleaf/`; the former `~/projects/underleaf/` checkout is historical, not a running deployment.
- `overroot-deploy.timer` accepts only exact-main successful push CI, builds both apps, backs up, and gracefully switches releases. Changes to the installed updater or units require explicit installation; application deployment does not install host automation changes.
- Verify code with `pnpm check && pnpm test:compiler`. The latter uses real Docker to test isolated compiler access to nested private source files. Keep the production data directory private while preserving the isolated worker's staging traversal/read permissions.
- Persistent service changes must update the response check at `~/uptime/overroot.py` and any schedule checks. Liveness probes never compile documents or mutate app data.
