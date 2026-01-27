# Installation and Setup

## Prerequisites

- Node.js (LTS, e.g. 18+)
- npm (or pnpm/yarn if you prefer, commands below assume npm)
- Git

## 1. Clone or Open the Project

If you are setting this up on a new machine:

```bash
git clone <YOUR_REPO_URL> polymarket-arb
cd polymarket-arb
```

If you are working inside Trae, you are already in the project root:

```bash
cd /Users/user/Documents/trae_projects/polymarket
```

## 2. Install Dependencies

### API Service

```bash
cd FKPolyTools_Repo/api_src
npm install
```

### Web Dashboard

```bash
cd ../web_front_src
npm install
```

## 3. Environment Variables

Create an `.env` file in `FKPolyTools_Repo/api_src` (or copy from `.env.example` if present) and set at least:

- `POLY_PRIVKEY` – private key for the signer (EOA associated with your Polymarket account / proxy).
- `POLY_PROXY_ADDRESS` – Polymarket proxy funder address (for signatureType=1 flows).
- Any other variables already referenced in `config.ts` / `config.js` (RPC URL, DB paths, etc.).

**Never commit a real `.env` file to git.**

## 4. Running the Services

### Start API

```bash
cd FKPolyTools_Repo/api_src
npm run dev
```

- API base: `http://localhost:3000`
- Swagger / docs: `http://localhost:3000/docs`

### Start Web Dashboard

In another terminal:

```bash
cd FKPolyTools_Repo/web_front_src
npm run dev -- --port 5173
```

- Dashboard: `http://localhost:5173`

## 5. Quick Sanity Checks

- Visit `http://localhost:3000/docs` – API docs should load.
- Visit `http://localhost:5173` – Dashboard should load.
- From a terminal, test a couple of endpoints (adjust IDs as needed):

```bash
curl -s http://localhost:3000/api/group-arb/status
curl -s http://localhost:3000/api/group-arb/open-orders | head
```

If these work, your local environment is healthy.
