# Hem Vault website

Marketing site + documentation for **Hem Vault** (repo: `ai-mcp-brain`).

Docs are single-sourced from the repo [`docs/`](../docs/) folder (plus `INSTALL.md` / `UNINSTALL.md`).

## Develop

```bash
cd site
npm install
npm run dev
```

Open http://localhost:4321

## Build

```bash
cd site
npm run build
npm run preview
```

Static output: `site/dist/`

## Deploy (Vercel)

Production: [https://hemvault.sayar.one](https://hemvault.sayar.one)

Deploy from **repo root** (so `docs/` + `INSTALL.md` are available to the Astro build). Root [`vercel.json`](../vercel.json) runs install/build under `site/` and publishes `site/dist`.

```bash
# from repo root
vercel --prod
```

Design tokens: [`design-system/hem-vault/MASTER.md`](../design-system/hem-vault/MASTER.md)
