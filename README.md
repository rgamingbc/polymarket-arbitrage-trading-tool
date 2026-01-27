# Polymarket Arbitrage Trading Tool

Local tooling and services for scanning Polymarket markets and executing structured arbitrage strategies, with a focus on weather / temperature markets.

This repository currently contains:

- **Python helpers** at the root (experimental, not primary focus now).
- **`FKPolyTools_Repo/`** – TypeScript/Node monorepo with:
  - `src` – SDK core (clients, services, utilities).
  - `api_src` – Fastify API server used in this Trae project.
  - `web_front_src` – Vite/React web dashboard for monitoring.
- **`static/`** – Local TypeScript files that override / extend SDK behavior for this project (group arbitrage scanner, trading client override, local routes).

## Development

From the project root:

```bash
# 1) Install dependencies for API
cd FKPolyTools_Repo/api_src
npm install

# 2) Install dependencies for web dashboard
cd ../web_front_src
npm install

# 3) Start API server (Fastify on :3000)
cd ../api_src
npm run dev

# 4) Start web dashboard (Vite on :5173)
cd ../web_front_src
npm run dev -- --port 5173
```

The API is exposed at `http://localhost:3000` and the docs are served at `http://localhost:3000/docs`.

The dashboard is exposed at `http://localhost:5173`.

See `docs/INSTALL.md` for detailed setup instructions and `docs/GROUP_ARB_STRATEGY.md` for the current trading logic.
