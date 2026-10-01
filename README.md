# ClarityDesk

ClarityDesk is a local-first workspace for exploring spreadsheets and asking questions about documents. It includes a React frontend and a FastAPI service. Spreadsheet summaries and charts are calculated locally; document questions use Ollama when the `llama3.2` model is available.

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

`APP_ORIGINS` is a comma-separated exact-origin allowlist for credentialed API requests. `CLARITYDESK_PORT` changes the host port. `AI_PROVIDER` is `ollama` by default and can be set to `gemini`; `OLLAMA_BASE_URL` configures the local model-service URL and Compose defaults it to `http://host.docker.internal:11434` so a container can reach Ollama on the Windows host. Gemini uses `GEMINI_API_KEY` and `GEMINI_MODEL`; the key is always supplied through an uncommitted environment or secret manager. Do not set `APP_ORIGINS=*` while credentials are enabled. The Compose setup does not run Ollama.

### Render Blueprint deployment

`render.yaml` defines a public `claritydesk` frontend web service and a private `claritydesk-backend` service. The backend owns a 10 GB persistent disk for the SQLite database, signing key, and uploaded workspace files. This deployment uses the existing Docker images, but the Render frontend has a separate Nginx config so `/api/*` reaches the private backend service over Render's internal network.

1. Push this repository to GitHub (already done for `VIVISANA/ClarityDesk`), then sign in to [Render](https://dashboard.render.com/).
2. Select **New → Blueprint**, connect the GitHub repository, choose the `main` branch, and select `render.yaml`.
3. Review the two services and approve the paid `starter` plans and persistent disk. Render's free plan cannot provide the persistent disk required for account and file storage.
4. Create the Blueprint. If Render asks for the `APP_ORIGINS` value before the frontend URL exists, enter the frontend service URL shown by Render or temporarily leave the service pending; do not use `*`.
5. Copy the frontend service's HTTPS URL, set that exact URL in the backend service's `APP_ORIGINS` environment variable, and manually redeploy the backend. Render provides `PORT` to the backend automatically; the backend Dockerfile uses it while defaulting to `8000` for native and local Compose use.
6. Open the frontend service URL and check `/api/health` through that same origin. The backend health response should be `200` even when Ollama is unavailable.

Required Render configuration is `APP_ORIGINS` (the exact frontend URL), `AI_PROVIDER=gemini`, `GEMINI_MODEL` (default `gemini-2.5-flash-lite`), and the secret `GEMINI_API_KEY` from Google AI Studio. `CLARITYDESK_DATA_DIR`, the persistent disk, and the backend `PORT` are configured automatically by the Blueprint/runtime. `OLLAMA_BASE_URL` is blank in Render because a hosted service cannot reach Ollama on your Windows machine. Spreadsheet calculations remain deterministic and do not use Gemini; PDF/document and open-ended spreadsheet questions use the selected provider. After Render assigns or changes the frontend URL, update `APP_ORIGINS` and redeploy the backend.

### Gemini setup and limitations

Create an API key in [Google AI Studio](https://aistudio.google.com/apikey), then set `AI_PROVIDER=gemini`, `GEMINI_MODEL=gemini-2.5-flash-lite`, and `GEMINI_API_KEY` in the local environment or Render dashboard. Never put the key in Git, `.env.example`, logs, browser code, or a public issue. A Google account or consumer Gemini/Google One subscription does not by itself grant API access; Google AI Studio API access, region availability, billing/quota settings, and current model availability are separate. Free-tier quotas and rate limits can change, and prompts containing uploaded document text or spreadsheet samples are sent to Google's API when Gemini is selected. Review Google's current pricing, retention, privacy, and regional terms before using sensitive data. If Gemini is unavailable, switch back to `AI_PROVIDER=ollama` with a local Ollama model; no automatic provider fallback is performed.

Render exposes the frontend publicly, so use HTTPS, a reviewed authentication design, backups and access controls for the persistent disk, rate limits, monitoring, and strict origin configuration before sharing the URL. The Render Blueprint contains no secrets or API tokens. Creating the Blueprint still requires an authorized Render dashboard account; this repository cannot create it without Render authorization.

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
- `render.yaml` — Render Blueprint with public frontend health checks, private backend, and persistent storage.
- `.github/workflows` — validation and GHCR image publishing.

## Limitations

PDFs need selectable text; scanned documents require OCR, which is not included. Spreadsheet Q&A handles common summaries, counts, groupings, and charts locally; it is not a general-purpose statistics or machine-learning system. Workspaces do not synchronize between devices.
