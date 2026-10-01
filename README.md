# ClarityDesk

ClarityDesk is a local-first workspace for exploring spreadsheets and asking questions about documents. It includes a React frontend and a FastAPI service. Spreadsheet summaries and charts are calculated locally; document questions use Ollama when the `llama3.2` model is available.

**Live demo:** [claritydesk-9ycf.onrender.com](https://claritydesk-9ycf.onrender.com/)

The hosted demo runs on Render's free tier: it may sleep after inactivity and its filesystem is ephemeral. Do not use it for real user data or persistent accounts; see the deployment caveats below.

## Choose a deployment

### Local development on Windows

Install Python 3.10+, Node.js 20+, and the Python dependencies:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
cd frontend
npm install
cd ..
```

Start both services with `Start-ClarityDesk.cmd` (the original `Start-Fieldnote.cmd` remains as a compatibility alias), or run them separately:

```powershell
.venv\Scripts\python.exe -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000
cd frontend
npm run dev -- --host 127.0.0.1
```

Open the Vite URL, normally `http://127.0.0.1:5173`. Vite proxies `/api` to the local FastAPI service. The API health endpoint is `http://127.0.0.1:8000/api/health`.

For PDF and open-ended document questions, install Ollama and run `ollama run llama3.2`. Spreadsheet tools remain available without a model provider. Native development defaults to `AI_PROVIDER=ollama`, `OLLAMA_MODEL=llama3.2`, and `http://127.0.0.1:11434`; set `OLLAMA_BASE_URL` if Ollama listens elsewhere.

### Docker Compose

Docker Compose runs the FastAPI backend and an Nginx frontend/reverse proxy behind one browser origin:

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

Open `http://localhost:8080`. The frontend serves the built React app and proxies `/api/*` to the backend container. Uploaded files, account data, and the signing key are stored in the named `claritydesk-data` volume. Stop services with `docker compose down`; keep the volume to preserve local data.

`APP_ORIGINS` is a comma-separated exact-origin allowlist for credentialed API requests. `CLARITYDESK_PORT` changes the host port. `AI_PROVIDER` is `ollama` by default and can be set to `gemini`; `OLLAMA_BASE_URL` configures the local model-service URL and Compose defaults it to `http://host.docker.internal:11434` so a container can reach Ollama on the Windows host. Gemini uses `GEMINI_API_KEY`, `GEMINI_MODEL`, and optional `GEMINI_FALLBACK_MODEL`; the key is always supplied through an uncommitted environment or secret manager. Do not set `APP_ORIGINS=*` while credentials are enabled. The Compose setup does not run Ollama.

### Render Blueprint deployment

`render.yaml` defines one public free `claritydesk` web service. Its Render-specific image runs the FastAPI backend and Nginx frontend together, so it does not require a paid private service or persistent disk.

1. Push this repository to GitHub (already done for `VIVISANA/ClarityDesk`), then sign in to [Render](https://dashboard.render.com/).
2. Select **New → Blueprint**, connect the GitHub repository, choose the `main` branch, and select `render.yaml`.
3. Select the **Free** instance type and create the single service. No payment information is required for this demo deployment.
4. Copy the service's HTTPS URL, set the `APP_ORIGINS` environment variable to that exact URL, and redeploy. Do not use `*`.
5. Open the service URL and check `/api/health` through that same origin. The response should be `200` even when Gemini is unavailable.

Required Render configuration is `APP_ORIGINS` (the exact service URL), `AI_PROVIDER=gemini`, `GEMINI_MODEL` (default `gemini-2.5-flash-lite`), optional `GEMINI_FALLBACK_MODEL` (default `gemini-flash-lite-latest`), and the secret `GEMINI_API_KEY` from Google AI Studio. The fallback is attempted only after bounded retries of a primary 503/high-demand or transport-unavailable failure; authentication, invalid-request, model-not-found, safety, and quota errors do not switch models. The image uses Render's injected `PORT` for Nginx and keeps the backend on its internal loopback port. `CLARITYDESK_DATA_DIR` is `/tmp/claritydesk-data`, and `OLLAMA_BASE_URL` is blank because a hosted service cannot reach Ollama on your Windows machine. Spreadsheet calculations remain deterministic and do not use Gemini; PDF/document and open-ended spreadsheet questions use the selected provider.

**Free demo limitations:** Render's free service sleeps after inactivity, has limited compute, and its filesystem is ephemeral. Accounts, uploaded files, the signing key, and other local state can disappear on restart, redeploy, or service replacement. Do not use this free demo for real user data, production accounts, backups, or compliance workloads. For production, use a paid persistent disk or an external database/object-storage design, a paid always-on service, HTTPS controls, backups, monitoring, rate limits, and a reviewed authentication strategy.

### Gemini setup and limitations

Create an API key in [Google AI Studio](https://aistudio.google.com/apikey), then set `AI_PROVIDER=gemini`, `GEMINI_MODEL=gemini-2.5-flash-lite`, `GEMINI_FALLBACK_MODEL=gemini-flash-lite-latest`, and `GEMINI_API_KEY` in the local environment or Render dashboard. Never put the key in Git, `.env.example`, logs, browser code, or a public issue. The health response lists only compatible model names and whether the primary/fallback are available; it never exposes the key. A Google account or consumer Gemini/Google One subscription does not by itself grant API access; Google AI Studio API access, region availability, billing/quota settings, and current model availability are separate. Free-tier quotas and rate limits can change, and prompts containing uploaded document text or spreadsheet samples are sent to Google's API when Gemini is selected. Review Google's current pricing, retention, privacy, and regional terms before using sensitive data. If Gemini is unavailable, switch back to `AI_PROVIDER=ollama` with a local Ollama model.

Render exposes the service publicly, so use strict origin configuration and treat the free deployment as a disposable demo. The Render Blueprint contains no secrets or API tokens. Creating the Blueprint still requires an authorized Render dashboard account; this repository cannot create it without Render authorization.

## Supported files and limits

My files accepts CSV, TSV, Excel (`.xlsx`, `.xlsm`, `.xls`), OpenDocument spreadsheets (`.ods`), PDFs, Word (`.docx`), PowerPoint (`.pptx`), and public Google Sheets links. Legacy `.doc` and `.ppt` files are not supported.

Uploads are limited to 25 MB for spreadsheets, 40 MB for PDFs and Office documents, and 15 MB for Google Sheets imports. Spreadsheet imports are also limited to 500,000 rows and 200 columns. These limits protect a local installation from unexpectedly large parsing jobs.

## Privacy and production security

ClarityDesk is designed for local-first use. Accounts, uploaded files, and browser-saved analyses stay on the configured device or Docker volume. No cloud AI is included. Google Sheets import downloads a link-accessible CSV from Google, and Ollama requests go to the configured local model service.

Before exposing a deployment beyond a trusted machine:

- Put the frontend behind HTTPS and a production reverse proxy with rate limits.
- Replace the device-local password/session design with a reviewed identity system and rotate the signing key securely.
- Restrict `APP_ORIGINS` to the real HTTPS origin; never use wildcard origins with credentials.
- Protect Docker volumes and backups, use a non-root deployment policy where appropriate, and monitor disk usage.
- Keep Ollama private and review prompts/data handling before allowing network access.
- Set upload limits at every proxy layer, not only in FastAPI.
- Do not expose the backend container directly to the public network; only the frontend proxy should be published.

This repository's GitHub Actions validate Python/frontend builds and build both Docker images. Version tags publish images to GHCR using the workflow's ephemeral `GITHUB_TOKEN`; no application secrets are committed. Deployment remains an operator decision using the provided Compose or Render configuration.

## Project layout

- `backend/main.py` — FastAPI API, authentication, file parsing, local analysis, and Ollama integration.
- `frontend/src` — React application.
- `frontend/nginx.conf` — production SPA fallback and `/api` reverse proxy.
- `docker-compose.yml` — single-origin production-style local deployment.
- `render.yaml` — Render Blueprint for the free combined frontend/backend demo service.
- `.github/workflows` — validation and GHCR image publishing.

## Limitations

PDFs need selectable text; scanned documents require OCR, which is not included. Spreadsheet Q&A handles common summaries, counts, groupings, and charts locally; it is not a general-purpose statistics or machine-learning system. Workspaces do not synchronize between devices.
