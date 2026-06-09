# Part Scraper App

A ChatGPT app for pasting email clips, extracting one or more part numbers, looking up DigiKey stock, status, and pricing, and suggesting likely drop-in substitutes.

The app also stores looked-up part data in a local SQLite database so repeat lookups are fast and disk-efficient.

## What it does

- `parts.analyze_clip` accepts a pasted email clip, extracts likely part numbers, looks up DigiKey data, and recommends substitute candidates.
- `parts.cache_summary` reports how many part records are currently cached locally.
- The server caches lookups in `part-cache.sqlite` using Node's built-in `node:sqlite` module.
- Demo mode keeps the app working without DigiKey credentials and returns mock results for local testing.

## Why this shape

- Primary archetype: `interactive-decoupled`
- Reason: the app has a persistent widget, repeated clip analysis, and result cards that should stay mounted while the tool runs.

## Current docs used

- [Apps SDK MCP server guide](https://developers.openai.com/apps-sdk/build/mcp-server)
- [Apps SDK ChatGPT UI guide](https://developers.openai.com/apps-sdk/build/chatgpt-ui)
- [Apps SDK quickstart](https://developers.openai.com/apps-sdk/quickstart)
- [Apps SDK reference](https://developers.openai.com/apps-sdk/reference)

## File tree

- `package.json`
- `package-lock.json`
- `.env.example`
- `README.md`
- `src/server.mjs`
- `src/widget.html`

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and edit it. The server loads `.env` automatically on startup.

3. Run the server in HTTP mode:

   ```bash
   npm run start:http
   ```

4. Open the local preview at `http://localhost:3000/preview`.
5. Open the MCP endpoint at `http://localhost:3000/mcp`.

## Environment

- `MCP_ALLOW_DEMO=true` keeps the app in mock/demo mode.
- `DIGIKEY_CLIENT_ID` and `DIGIKEY_CLIENT_SECRET` enable live DigiKey requests.
- `DIGIKEY_CUSTOMER_ID` defaults to `0`.
- `DIGIKEY_ACCOUNT_ID` is optional for account-scoped requests.
- `DIGIKEY_API_BASE_URL` defaults to `https://api.digikey.com`.
- `DIGIKEY_LOCALE_LANGUAGE`, `DIGIKEY_LOCALE_CURRENCY`, and `DIGIKEY_LOCALE_SITE` control DigiKey locale headers.

## Local cache

- Cached part data is stored in `part-cache.sqlite` in the project root.
- The cache uses SQLite WAL mode and Node's built-in `node:sqlite` runtime.
- You can delete the database file at any time if you want a clean cache; the app will recreate it automatically.

## Validation

- `node --check src/server.mjs`

## Next steps

1. Add DigiKey credentials to `.env` if you want live lookups instead of demo mode.
2. Open `http://localhost:3000/preview` and paste a real email clip to test part extraction.
3. If you want, I can add a richer substitution scoring model or an export view next.
