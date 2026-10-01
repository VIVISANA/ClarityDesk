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

For PDF and open-ended document questions, install Ollama and run `ollama run llama3.2`. Spreadsheet tools remain available without Ollama. Native development defaults to `http://127.0.0.1:11434`; set `OLLAMA_BASE_URL` if Ollama listens elsewhere.

### Docker Compose

Docker Compose runs the FastAPI backend and an Nginx frontend/reverse proxy behind one browser origin:

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

Open `http://localhost:8080`. The frontend serves the built React app and proxies `/api/*` to the backend container. Uploaded files, account data, and the signing key are stored in the named `claritydesk-data` volume. Stop services with `docker compose down`; keep the volume to preserve local data.

`APP_ORIGINS` is a comma-separated exact-origin allowlist for credentialed API requests. `CLARITYDESK_PORT` changes the host port. `OLLAMA_BASE_URL` configures the backend's model-service URL; Compose defaults it to `http://host.docker.internal:11434` so a Docker container can reach Ollama on the Windows host. Do not set `APP_ORIGINS=*` while credentials are enabled. The Compose setup does not run Ollama; provide a separately secured Ollama service and configure the application before enabling it in production.

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

This repository's GitHub Actions validate Python/frontend builds and build both Docker images. Version tags publish images to GHCR using the workflow's ephemeral `GITHUB_TOKEN`; no application secrets are committed. Deployment remains an operator decision using the provided Compose configuration.

## Project layout

- `backend/main.py` — FastAPI API, authentication, file parsing, local analysis, and Ollama integration.
- `frontend/src` — React application.
- `frontend/nginx.conf` — production SPA fallback and `/api` reverse proxy.
- `docker-compose.yml` — single-origin production-style local deployment.
- `.github/workflows` — validation and GHCR image publishing.

## Limitations

PDFs need selectable text; scanned documents require OCR, which is not included. Spreadsheet Q&A handles common summaries, counts, groupings, and charts locally; it is not a general-purpose statistics or machine-learning system. Workspaces do not synchronize between devices.
