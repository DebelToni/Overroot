# Production deployment

The frontend, REST API and WebSockets share `https://overroot.toni.foo`. A dedicated remotely managed Cloudflare Tunnel targets `http://127.0.0.1:4317`; its final ingress rule returns 404. No inbound router port or GitHub Pages site is required.

## Requirements and installation

The supplied user units target Anton's DGX paths. Other hosts must adjust the absolute Node/cloudflared executable paths and `PATH`. Install Node.js 24+, pnpm 10.27.0, Docker, cloudflared, Git and GitHub CLI. The service user needs Docker access, GitHub repository read access over SSH, and `gh` authentication with Actions read access. Enable systemd user lingering for boot persistence.

Create owner-only `~/.config/overroot/runtime.env`:

```dotenv
NODE_ENV=production
OVERROOT_HOST=127.0.0.1
OVERROOT_PORT=4317
OVERROOT_DATA_DIR=/home/xaj/.local/state/overroot/data
OVERROOT_BACKUP_DIR=/home/xaj/.local/state/overroot/backups
OVERROOT_ALLOWED_ORIGINS=https://overroot.toni.foo
OVERROOT_PUBLIC_URL=https://overroot.toni.foo
OVERROOT_TRUST_PROXY=true
OVERROOT_FAKE_COMPILER=false
```

Store the named tunnel's connector token in `~/.config/overroot/tunnel-token` with mode 0600. Never put it in a unit, Git, or command arguments. Configure a proxied DNS CNAME for the app hostname to the dedicated tunnel's `UUID.cfargotunnel.com` target. Resource IDs are recorded privately in `~/.local/state/overroot/cloudflare.json`.

Install the reviewed updater and units from the source checkout:

```bash
mkdir -p ~/.local/lib/overroot ~/.config/systemd/user
install -m 700 scripts/deploy.mjs ~/.local/lib/overroot/deploy.mjs
install -m 600 deploy/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable overroot.service
```

For a fresh installation, first initialize the database and administrator from the checkout with `OVERROOT_DATA_DIR` pointing to the configured production data directory, using `pnpm admin:create`. For a restoration, use the verified database instead, with filename `overroot.sqlite3`; retain the original recovery copy. Do not launch a second server against production data.

After pushing to `main` and waiting for CI:

```bash
systemctl --user start overroot-deploy.service
systemctl --user enable --now overroot-cloudflared.service overroot-deploy.timer overroot-backup.timer
```

The first command reports `awaiting-ci` without changing production if no matching successful CI run exists. Repeat after CI finishes; on an approved commit it also starts the backend.

## Update contract

The timer checks every three minutes. GitHub requires PRs, passing CI/CodeQL and owner/admin merging into `main`; [review policy and same-session handoff](REVIEW.md) describe that gate. Only a completed successful `ci.yml` **push** run for the current `main` SHA approves a production update; pull-request runs cannot authorize deployment. CI runs application/updater checks and a real restricted-Docker compilation using nested source files.

The updater fetches into its own bare repository, extracts the approved source, installs locked dependencies, and builds both frontend and backend before touching the running service. It then takes an online backup, stops gracefully, atomically switches `current`, starts the backend and polls `/health`. A success receipt is written only after health passes.

A failed build or backup leaves the running release untouched. A failed restart or health check fails the deployment visibly and requires operator attention; there is no automatic rollback. `/health` proves that the process responds, not that every document compiles. Live monitoring also checks the frontend, public API, tunnel connector and update schedule without writing application data.

| Path under `~/.local/state/overroot/` | Purpose |
| --- | --- |
| `data/overroot.sqlite3` | Accounts, documents, revisions and collaboration state |
| `data/compile-cache/` | PDFs, logs and SyncTeX artifacts |
| `data/jobs/` | Transient, compiler-readable staging inside the private data directory |
| `releases/<sha>-*/`, `current` | Built releases and the active symlink |
| `deploy-repo.git/` | Independent deployment Git storage |
| `deployed.json` | Last successful SHA and deployment timestamp |
| `backups/` | Three rotating verified online snapshots |

Development checkout changes do not affect the running release. Installing a changed updater or unit requires reviewing and repeating the installation commands; deploying a new app commit does not replace the host controller. Old release directories are retained for manual recovery, not pruned automatically.

## Operations and backups

```bash
systemctl --user status overroot.service overroot-cloudflared.service overroot-deploy.timer overroot-backup.timer
journalctl --user -u overroot-deploy.service -u overroot.service -n 80
cat ~/.local/state/overroot/deployed.json
systemctl --user start overroot-backup.service
```

Backups run daily at 03:00 in the host timezone and before each deployment. They use SQLite's online-backup API, verify database integrity, copy generated artifacts, and exclude plaintext credentials. The latest three snapshots share the host disk and do not protect against disk loss. The archived pre-migration recovery remains separate; this setup does not establish a new off-host backup destination.

Before manual restore or rollback, stop the deploy and backup timers, wait for any running jobs to finish, take a fresh backup, and stop `overroot.service` gracefully. Restore a verified database and cache with the server stopped. Historical artifact paths in `compile_jobs.pdf_path` and `synctex_path` must point inside the configured current compile-cache directory when migrating hosts. Check schema compatibility before choosing an older release. Atomically repoint `current` if changing code, start the service, and verify public health before resuming the timers. Reconcile `deployed.json` with the selected release; otherwise the next approved `main` update may supersede a manual rollback.

Interrupted deployment locks and partially prepared releases are intentionally not repaired silently. Inspect `deploy.lock`, release directories and the journal before removing an abandoned lock or retrying.
