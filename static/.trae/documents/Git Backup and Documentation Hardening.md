## Goals
- Create a clean, restorable snapshot of your current Polymarket arbitrage tool.
- Add clear documentation so future you (or any LLM) can quickly understand and rebuild the system.
- Prepare the local git repo so you can safely push to a private GitHub repo under your account.

## Step 1 – Inspect / Initialize Local Git Repository (Read-Only Planning)
- Check if a `.git` directory already exists in `/Users/user/Documents/trae_projects/polymarket`.
- If not present, the implementation phase will:
  - Run `git init` in that directory to create a new repo.
- If it does exist, we’ll reuse it and not re-init.

## Step 2 – Add/Update .gitignore
- Create or refine a `.gitignore` at the project root to exclude:
  - `node_modules/`, `dist/`, `.turbo/` or other build/cache folders
  - Local databases (e.g. `*.sqlite`, `data/`), logs, temporary files
  - Environment files: `.env`, `.env.local`, secrets
  - OS/editor junk (e.g. `.DS_Store`, `.idea/`, `.vscode/` as you prefer)
- Ensure only source code, configs (without secrets), and docs are tracked.

## Step 3 – Core Documentation Files
During implementation we will create or update these files in the repo:

1) **README.md** (high-level overview)
- Purpose of the project: “Polymarket arbitrage trading tool (weather/temperature scanner + group arbitrage).”
- High-level architecture:
  - `FKPolyTools_Repo/api_src` – API service (Fastify + SDK)
  - `FKPolyTools_Repo/web_front_src` – web dashboard (Vite + React/AntD)
  - `static/` – local TypeScript helpers (group-arbitrage, trading-client-override, routes)
- Quickstart for development:
  - How to install dependencies.
  - How to run API (`npm run dev` in `api_src`).
  - How to run web frontend (`npm run dev` in `web_front_src`).

2) **docs/INSTALL.md** (detailed setup)
- Prerequisites: Node.js version, npm/pnpm, git.
- Step-by-step:
  - Clone or copy repo.
  - Install dependencies in each package.
  - Copy `.env.example` to `.env` and fill required variables (without actual secrets).
  - Start API + web UI; confirm URLs (`http://localhost:3000`, `http://localhost:5173`).

3) **docs/GROUP_ARB_STRATEGY.md** (trading logic)
- Describe the current strategy and features:
  - Weather/temperature market scanning and opportunity metrics.
  - “Buy All” logic: preview + execute with 0.90 total cost target, equal size on YES/NO.
  - Manual buy-all endpoint with fixed size (e.g. Ankara YES 24¢ / NO 58¢, size 5).
- List important API endpoints:
  - `/api/group-arb/scan`, `/preview`, `/execute`, `/execute-manual`.
  - Monitoring: `/status`, `/open-orders`, `/trades`, `/history`, `/orderbook`, `/ctf-custody`.
- Note key limitations/assumptions:
  - Using proxy funder address; merge/redeem automation deferred.
  - Cut-loss and post-trade rules (2)/(3) still to be implemented as a state machine.

4) **docs/CHANGELOG-LLM.md** (session-based history)
- Add entries capturing what we’ve done so far, for example:
  - Trading client override + weather scanner.
  - Group-arb scan/preview/execute.
  - Manual Ankara test: YES 24c / NO 58c, size 5.
  - Dashboard monitoring features.
- Each entry: date, short summary, main files/endpoints touched.

5) **docs/DEPLOY.md** (initial deploy notes)
- Outline how you might deploy later (even if you don’t do it now):
  - Required environment variables (names only, no values).
  - Expected ports and processes (API server, web server).
  - Basic notes about running behind a reverse proxy and keeping secrets in env variables.

## Step 4 – Prepare for Remote Backup
- After docs are in place and tracked by git, the implementation phase will:
  - Run `git status` to verify a clean view of tracked/untracked files.
  - Stage all desired files: `git add .` (respecting `.gitignore`).
  - Create an initial milestone commit with a clear message, e.g.:
    - `chore: snapshot polymarket arbitrage trading tool (weather scanner + manual buy-all)`
- At this stage, your local repo will already contain a full snapshot, even before pushing.

## Step 5 – Connect to GitHub (You + Me Together)
- You will create a **private** GitHub repo (e.g. `RGamingbc/polymarket-arbitrage-trading-tool`).
- You share only the **HTTPS remote URL** in chat (no password or token).
- After that (outside plan mode), I will:
  - Add the remote: `git remote add origin <your-https-url>` (or adjust if a remote already exists).
  - Push the current branch: `git push -u origin main`.
- Authentication uses your machine’s git credentials; I never see them.

## Step 6 – How This Helps You Later
- With code + docs + changelog in git, you can:
  - Rebuild the project on any machine by following `docs/INSTALL.md`.
  - Brief any LLM quickly by pasting `docs/GROUP_ARB_STRATEGY.md` and the relevant section of `docs/CHANGELOG-LLM.md`, instead of full raw transcripts.
  - Track future changes and new strategies as additional commits and changelog entries.

If you approve this plan, the next step will be to implement Steps 1–4 in your local repo, then I’ll guide you through creating the GitHub repo and perform the remote wiring and push in collaboration with your credentials.