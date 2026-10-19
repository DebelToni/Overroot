<div align="center">

# Overroot

**A private, invite-only collaborative LaTeX studio for people and software agents.**

[Hosted app](https://overroot.toni.foo) · [Agent guide](https://overroot.toni.foo/agent-guide.md) · [Questions / chat](https://github.com/DebelToni/Overroot/issues/new)

[![CI](https://github.com/DebelToni/Overroot/actions/workflows/ci.yml/badge.svg)](https://github.com/DebelToni/Overroot/actions/workflows/ci.yml)
[![CodeQL](https://github.com/DebelToni/Overroot/actions/workflows/codeql.yml/badge.svg)](https://github.com/DebelToni/Overroot/actions/workflows/codeql.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-5e6ad2.svg)](LICENSE)

</div>

<p align="center">
  <img src=".github/readme/workspace.png" alt="Overroot desktop workspace with file tree, collaborative LaTeX editor, and PDF preview" width="100%">
</p>

<p align="center">
  <img src=".github/readme/dashboard.png" alt="Overroot project dashboard in dark mode" width="68%">
  &nbsp;
  <img src=".github/readme/mobile.png" alt="Overroot mobile PDF workspace" width="25%">
</p>

Overroot serves its frontend, REST API, and collaborative WebSockets from one Node server on the DGX at `https://overroot.toni.foo`, through a dedicated named Cloudflare Tunnel. GitHub Actions checks changes before a host-side deployment timer can publish an immutable release. Docker is used only for isolated Tectonic compilation.

Overroot is private and accepts new members through single-use invitation links. Questions about using or hosting Overroot are welcome in [GitHub Issues](https://github.com/DebelToni/Overroot/issues).

Overroot is independent and unaffiliated with Overleaf or Underleaf.ai.

## What it includes

- Multi-file CodeMirror LaTeX editor with live Yjs/WebSocket collaboration and presence
- Owner, editor, and viewer project roles
- Restricted Docker/Tectonic compilation with a warm worker and persistent package cache
- Live compile state, logs, PDF replacement, and source-aware revision history
- PDF viewer that preserves page, zoom, and exact scroll position after recompilation
- One-click PDF-only mode with `Escape` to return
- Article, report, presentation, and blank templates; file uploads and ZIP import/export
- Light, dark, and system appearance across desktop and mobile layouts
- Project-scoped, revocable credentials for external agents
- SQLite persistence plus an online backup command with bounded snapshot retention

## Using the hosted instance

### 1. Register with an invitation

An administrator opens **Invitations**, selects **New invitation**, and sends the generated link privately.

- Each invitation can register one account.
- The link expires after seven days when created through the interface.
- Registration needs only a username and password.
- Registering does not automatically reveal or share any project.

Create a separate invitation for every person. If a link is consumed by the wrong person, create a replacement rather than sharing an account.

### 2. Create and share a project

1. Select **New project** on the dashboard.
2. Name it and choose a starting template.
3. Open **Share** inside the project.
4. Add the collaborator's exact registered username as **Editor** or **Viewer**.
5. The collaborator refreshes their dashboard and opens the shared project.

Editors can work in the same text file simultaneously. Presence appears in the header, changes synchronize live, and **History** records who produced each saved revision.

### Write as one manuscript

Projects open in **Manuscript**, a continuous editable LaTeX source view. Literal
`\input{sections/introduction}` and `\include{sections/results}` commands expand
their source files in place. Every edit saves to its original file; there is no
merged file to synchronize. Agents keep using the same modular files and API.

File headings and expanded include commands are protected. Edit within one
section at a time; selections crossing a file boundary can be copied but cannot
be replaced or deleted. **Files**, or selecting an item in the file tree, opens
the individual source editor for changing includes, file structure, bibliography,
or other project files. Switching views and compiling first synchronize all open
modules. The cursor's original file and line drive PDF highlighting and History.

The view expands literal braced includes from the compilation root, including
nested inputs. It does not evaluate TeX macros or conditional execution. Comments,
verbatim examples and inputs inside macro arguments are not expanded. Missing,
repeated and cyclic inputs display a warning; repeated files appear once for
editing. Advanced TeX remains available in **Files**, and compilation and ZIP
exports always use the original project files.

### 3. Compile and review

Select **Compile** to flush the current collaborative editor state and run Tectonic. Successful output appears in the PDF pane for every connected collaborator. A completely empty document body has no printable page, so add content between `\begin{document}` and `\end{document}` before compiling a blank template.

## External agent access

Overroot does not embed an AI model or chat interface. A project owner can authorize an external coding agent to edit the project directly:

1. Open **Agents** in the project.
2. Create a named credential.
3. Give the agent the API base link, project hash, and one-time password shown by Overroot.

The credential grants access to that project only and can be revoked independently. Agents can read and edit files, create and restore revisions, compile, download PDFs, and export ZIP archives through the REST API. Mutations use `If-Match` revisions so an agent cannot silently overwrite a newer collaborator change.

- Human/agent guide: [`apps/web/public/agent-guide.md`](apps/web/public/agent-guide.md)
- Live guide: https://overroot.toni.foo/agent-guide.md
- OpenAPI: `/api/v1/openapi.json` on the API base link

## Contributing code (people and coding agents)

To change Overroot itself, use GitHub pull requests rather than the project-document API above:

1. Read [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md) for instructions and required checks.
2. Create a branch from `main`, or use a fork if you do not have repository write access.
3. Open a non-draft PR targeting `main`. For a draft, select **Ready for review** when finished. No special label, mention, deployment credential, or separate request to the maintainer's agent is needed.

The host watcher polls about once a minute and queues the PR's exact head and base revisions into the maintainer's existing Pi session. If its tmux window is closed, the watcher resumes the same saved session before delivering the review. Reviews wait behind current work. The agent reviews correctness and security, and may squash-merge a clean, up-to-date revision after CI and CodeQL pass. Findings, uncertainty, or reviewer account unavailability leave the PR unmerged; changed revisions receive a fresh review. Production deployment then follows the `main` CI gate shown below.

Direct pushes, force pushes, and deletion of `main` are blocked, including for the owner. Only the owner/admin can merge; contributors cannot merge each other's PRs. See [`deploy/REVIEW.md`](deploy/REVIEW.md) for the complete policy.

## Architecture

```text
GitHub Actions (pnpm check + Docker compiler regression test)
        │ successful CI for exact main commit
        ▼
Host timer (every 3 minutes) ──► immutable release build
                                      │ backup, graceful switch, health receipt
                                      ▼
https://overroot.toni.foo ──► named Cloudflare Tunnel ──► Node on DGX:4317
                                                          ├─ static frontend
                                                          ├─ REST API + OpenAPI
                                                          ├─ Yjs collaboration + WebSockets
                                                          └─ Docker-isolated Tectonic compiler
```

## Self-hosting

Requirements, host setup, runtime paths, deployment commands, and recovery are documented in [`deploy/README.md`](deploy/README.md).

## Compilation isolation

The first real compile builds `overroot-tectonic:0.16.9` if necessary and starts `overroot-tectonic-worker`. It runs as an unprivileged user with dropped capabilities, a read-only root filesystem, PID/CPU/memory limits, Tectonic `--untrusted`, and a compile timeout. Only the jobs directory is writable; downloaded packages remain in the `overroot-tectonic-cache` Docker volume.

The cache key includes the entry file, compiler context, flags, paths, and every source revision. An identical project state reuses its existing PDF immediately.

## Data and backups

SQLite and generated runtime data live outside the source repository. Backup location, retention, and restore details are documented in [`deploy/README.md`](deploy/README.md).

## Local development

```bash
pnpm dev
```

Open http://localhost:5173. The development frontend connects directly to http://127.0.0.1:4317.

Run every quality gate with:

```bash
pnpm check && pnpm test:compiler
```

This performs ESLint, strict TypeScript checks, backend/frontend tests, production builds, and a real Docker-based compiler regression test. CI runs the same checks, and CodeQL scans JavaScript and TypeScript changes.

## Security scope

Overroot is designed for a small trusted group rather than public registration. Passwords use scrypt; session, invitation, WebSocket, and agent secrets are stored as hashes or short-lived one-use tickets. ZIP extraction and project paths are bounded, CORS is allowlisted, and LaTeX compilation is isolated from the host.

The production frontend and API share one origin behind the dedicated Cloudflare Tunnel. If the host or its network is unavailable, the service is unavailable while SQLite data remains on the host.

Please report security concerns according to [SECURITY.md](SECURITY.md).

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
