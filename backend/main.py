from __future__ import annotations

import io
import contextvars
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import shutil
import time
import urllib.error
import urllib.request
import uuid
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fitz
import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

app = FastAPI(title="ClarityDesk", version="0.2.0")
datasets: dict[str, pd.DataFrame] = {}
DATA_ROOT = Path(os.getenv("CLARITYDESK_DATA_DIR", str(Path(__file__).parent)))
DATA_ROOT.mkdir(parents=True, exist_ok=True)
WORKSPACE_ROOT = DATA_ROOT / "workspace_files"
WORKSPACE_ROOT.mkdir(exist_ok=True)
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
AI_PROVIDER = os.getenv("AI_PROVIDER", "ollama").strip().lower()
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite").strip()
active_workspace = contextvars.ContextVar("fieldnote_workspace", default=None)
AUTH_DB = DATA_ROOT / "fieldnote_accounts.sqlite3"
AUTH_SECRET_FILE = DATA_ROOT / ".fieldnote-secret"
MAX_SPREADSHEET_BYTES = 25_000_000
MAX_PDF_BYTES = 40_000_000
MAX_OFFICE_BYTES = 40_000_000
MAX_GOOGLE_SHEET_BYTES = 15_000_000
MAX_SPREADSHEET_ROWS = 500_000
MAX_SPREADSHEET_COLUMNS = 200
FILE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


class ModelProviderError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def model_text(prompt: str) -> str:
    if AI_PROVIDER == "ollama":
        body = json.dumps({"model": OLLAMA_MODEL, "prompt": prompt, "stream": False}).encode("utf-8")
        request = urllib.request.Request(
            f"{OLLAMA_BASE_URL}/api/generate",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                result = json.loads(response.read().decode("utf-8"))
            answer = str(result.get("response", "")).strip()
        except (OSError, TimeoutError, ValueError) as exc:
            raise ModelProviderError(503, "The local Ollama model is unavailable. Start Ollama and ensure the configured model is installed.") from exc
    elif AI_PROVIDER == "gemini":
        if not GEMINI_API_KEY:
            raise ModelProviderError(503, "Gemini is selected but GEMINI_API_KEY is not configured.")
        endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
        body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode("utf-8")
        request = urllib.request.Request(endpoint, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.loads(response.read().decode("utf-8"))
            answer = str(result["candidates"][0]["content"]["parts"][0]["text"]).strip()
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                detail = "Gemini rejected the configured API key or model access."
            elif exc.code == 429:
                detail = "Gemini free-tier quota or rate limit was reached. Try again later."
            else:
                detail = "Gemini could not complete this request."
            raise ModelProviderError(502, detail) from exc
        except (OSError, TimeoutError, KeyError, IndexError, TypeError, ValueError) as exc:
            raise ModelProviderError(503, "Gemini is unavailable or returned an unexpected response.") from exc
    else:
        raise ModelProviderError(500, "AI_PROVIDER must be either 'ollama' or 'gemini'.")
    if not answer:
        raise ModelProviderError(502, "The selected AI provider returned an empty response.")
    return answer


def auth_secret() -> bytes:
    try:
        with AUTH_SECRET_FILE.open("xb") as secret_file:
            secret_file.write(secrets.token_bytes(32))
    except FileExistsError:
        pass
    return AUTH_SECRET_FILE.read_bytes()


AUTH_SECRET = auth_secret()


def auth_db() -> sqlite3.Connection:
    connection = sqlite3.connect(AUTH_DB)
    connection.row_factory = sqlite3.Row
    connection.execute("CREATE TABLE IF NOT EXISTS accounts (email TEXT PRIMARY KEY, name TEXT NOT NULL, salt BLOB NOT NULL, password_hash BLOB NOT NULL, workspace_id TEXT NOT NULL UNIQUE)")
    return connection


def password_hash(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 240_000)


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def issue_token(account: sqlite3.Row) -> str:
    payload = json.dumps({"email": account["email"], "workspace": account["workspace_id"], "exp": int(time.time()) + 86400 * 30}, separators=(",", ":")).encode()
    encoded = b64url(payload)
    signature = hmac.new(AUTH_SECRET, encoded.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded}.{b64url(signature)}"


def read_token(token: str) -> dict[str, Any] | None:
    try:
        encoded, supplied_signature = token.split(".", 1)
        expected = b64url(hmac.new(AUTH_SECRET, encoded.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(supplied_signature, expected):
            return None
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        claims = json.loads(payload)
        if int(claims.get("exp", 0)) < int(time.time()):
            return None
        return claims
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


class WorkspaceIsolationMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if not path.startswith("/api/") or path == "/api/health":
            await self.app(scope, receive, send)
            return
        if path in ("/api/auth/signup", "/api/auth/login"):
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        authorization = headers.get(b"authorization", b"").decode("ascii", errors="ignore")
        claims = read_token(authorization.removeprefix("Bearer ")) if authorization.startswith("Bearer ") else None
        if not claims:
            response = JSONResponse({"detail": "Sign in to your private ClarityDesk workspace."}, status_code=401)
            await response(scope, receive, send)
            return
        token = active_workspace.set(claims["workspace"])
        try:
            await self.app(scope, receive, send)
        finally:
            active_workspace.reset(token)


app.add_middleware(WorkspaceIsolationMiddleware)
app.add_middleware(
    CORSMiddleware,
    # Configure exact browser origins; never use "*" with credentials.
    allow_origins=[
        origin.strip()
        for origin in os.getenv(
            "APP_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174",
        ).split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AuthRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)
    name: str = Field(default="", max_length=120)


def account_response(account: sqlite3.Row) -> dict[str, str]:
    return {"name": account["name"], "email": account["email"], "workspace_id": account["workspace_id"], "access_token": issue_token(account)}


@app.post("/api/auth/signup")
def signup(request: AuthRequest) -> dict[str, str]:
    email = request.email.strip().casefold()
    name = request.name.strip()
    if "@" not in email or len(email) > 254:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    if len(request.password) < 8:
        raise HTTPException(status_code=400, detail="Use at least 8 characters for your password.")
    if not name:
        raise HTTPException(status_code=400, detail="Enter your name.")
    salt = secrets.token_bytes(16)
    connection = auth_db()
    try:
        connection.execute("INSERT INTO accounts (email, name, salt, password_hash, workspace_id) VALUES (?, ?, ?, ?, ?)", (email, name, salt, password_hash(request.password, salt), str(uuid.uuid4())))
        connection.commit()
        account = connection.execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="An account with this email already exists on this device. Sign in instead.") from exc
    finally:
        connection.close()
    return account_response(account)


@app.post("/api/auth/login")
def login(request: AuthRequest) -> dict[str, str]:
    email = request.email.strip().casefold()
    connection = auth_db()
    try:
        account = connection.execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
        if not account or not hmac.compare_digest(password_hash(request.password, account["salt"]), account["password_hash"]):
            raise HTTPException(status_code=401, detail="That email and password combination was not found on this device.")
        return account_response(account)
    finally:
        connection.close()


def workspace_files() -> Path:
    workspace_key = active_workspace.get()
    if not workspace_key:
        raise HTTPException(status_code=401, detail="Sign in to your private ClarityDesk workspace.")
    workspace_id = hashlib.sha256(workspace_key.encode("ascii")).hexdigest()
    folder = WORKSPACE_ROOT / "accounts" / workspace_id
    folder.mkdir(parents=True, exist_ok=True)

    # Files saved before account isolation are claimed once by the first signed-in
    # workspace, then never included in another account's library.
    claim_marker = WORKSPACE_ROOT / "accounts" / ".legacy-claimed"
    claim_marker.parent.mkdir(parents=True, exist_ok=True)
    if not claim_marker.exists():
        for metadata in WORKSPACE_ROOT.glob("*.json"):
            try:
                record = json.loads(metadata.read_text(encoding="utf-8"))
                payload_name = f"{record['file_id']}.{record['extension']}" if record.get("kind") == "spreadsheet" else f"{record['file_id']}.txt"
                payload = WORKSPACE_ROOT / payload_name
                if payload.exists():
                    shutil.move(str(payload), str(folder / payload.name))
                shutil.move(str(metadata), str(folder / metadata.name))
            except (OSError, KeyError, json.JSONDecodeError):
                continue
        claim_marker.write_text(workspace_id, encoding="ascii")
    return folder


def metadata_path(file_id: str) -> Path:
    if not FILE_ID_PATTERN.fullmatch(file_id):
        raise HTTPException(status_code=400, detail="That file identifier is invalid.")
    return workspace_files() / f"{file_id}.json"


async def read_upload(file: UploadFile, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(min(1024 * 1024, limit - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail=f"Files must be smaller than {limit // 1_000_000} MB.")
        chunks.append(chunk)
    return b"".join(chunks)


def file_metadata() -> list[dict[str, Any]]:
    records = []
    for path in workspace_files().glob("*.json"):
        try:
            records.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return sorted(records, key=lambda item: item.get("created_at", ""), reverse=True)


def get_dataset(file_id: str) -> pd.DataFrame | None:
    meta_path = metadata_path(file_id)
    if not meta_path.exists():
        return None
    if file_id in datasets:
        return datasets[file_id]
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if meta.get("kind") != "spreadsheet":
            return None
        source = workspace_files() / f"{file_id}.{meta['extension']}"
        data = source.read_bytes()
        if meta["extension"] == "csv":
            frame = pd.read_csv(io.BytesIO(data))
        elif meta["extension"] == "tsv":
            frame = pd.read_csv(io.BytesIO(data), sep="\t")
        else:
            frame = pd.read_excel(io.BytesIO(data), engine="odf" if meta["extension"] == "ods" else None)
        validate_spreadsheet_shape(frame)
        frame = frame.astype(object).where(pd.notna(frame), None)
        datasets[file_id] = frame
        return frame
    except (OSError, KeyError, ValueError, TypeError, ImportError):
        return None


class PdfPrompt(BaseModel):
    prompt: str = Field(min_length=1, max_length=120_000)
    task: str = Field(default="custom", max_length=32)


class SheetsRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class SpreadsheetQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=2_000)
    file_id: str = Field(min_length=32, max_length=32)


class DashboardRequest(BaseModel):
    file_id: str = Field(min_length=32, max_length=32)


class JoinRequest(BaseModel):
    left_file_id: str = Field(min_length=32, max_length=32)
    right_file_id: str = Field(min_length=32, max_length=32)
    left_on: str = Field(min_length=1, max_length=256)
    right_on: str = Field(min_length=1, max_length=256)
    join_type: str = Field(default="inner", max_length=16)


def validate_spreadsheet_shape(frame: pd.DataFrame) -> None:
    if len(frame) > MAX_SPREADSHEET_ROWS or len(frame.columns) > MAX_SPREADSHEET_COLUMNS:
        raise HTTPException(
            status_code=413,
            detail=f"Spreadsheets are limited to {MAX_SPREADSHEET_ROWS:,} rows and {MAX_SPREADSHEET_COLUMNS} columns.",
        )


def find_column(columns: list[str], question: str, numeric_columns: list[str] | None = None) -> str | None:
    lowered = question.casefold()
    candidates = sorted(columns, key=len, reverse=True)
    for column in candidates:
        if column.casefold() in lowered:
            return column
    if numeric_columns and len(numeric_columns) == 1:
        return numeric_columns[0]
    return None


def count_chart(series: pd.Series, title: str, series_name: str, limit: int | None = None, order: str = "frequency") -> dict[str, Any]:
    values = series.astype("string").fillna("Missing").value_counts().sort_values(ascending=False)
    if isinstance(series.dtype, pd.CategoricalDtype) and series.cat.ordered:
        values = values.reindex([str(category) for category in series.cat.categories], fill_value=0)
    elif order == "ascending":
        def category_key(value: Any) -> tuple[int, Any]:
            try:
                return (0, float(str(value).replace(",", "")))
            except ValueError:
                return (1, str(value).casefold())
        values = values.reindex(sorted(values.index, key=category_key))
    if limit and len(values) > limit:
        kept = values.head(limit).copy()
        kept.loc["Other values"] = int(values.iloc[limit:].sum())
        values = kept
    return {"title": title, "labels": [str(value) for value in values.index], "values": [int(value) for value in values.values], "series": series_name}


@app.post("/api/spreadsheets/dashboard")
def create_dashboard(request: DashboardRequest) -> dict[str, Any]:
    frame = get_dataset(request.file_id)
    if frame is None:
        raise HTTPException(status_code=404, detail="This spreadsheet is no longer available. Please add it again.")
    if frame.empty or len(frame.columns) == 0:
        raise HTTPException(status_code=400, detail="This spreadsheet has no data to chart.")
    required = ["Geography", "NumOfProducts", "CreditScore", "Gender", "Age", "Exited", "Tenure", "Balance"]
    missing = [column for column in required if column not in frame.columns]
    if missing:
        numeric = [column for column in frame.columns if pd.to_numeric(frame[column], errors="coerce").notna().sum() >= 2]
        categorical = [column for column in frame.columns if column not in numeric and 1 < frame[column].nunique(dropna=True) <= 30]
        charts = []
        for column in numeric[:4]:
            values = pd.to_numeric(frame[column], errors="coerce").dropna()
            if values.empty:
                continue
            bins = min(10, max(2, values.nunique()))
            grouped = pd.cut(values, bins=bins, duplicates="drop").value_counts().sort_index()
            charts.append({"title": f"{column} distribution", "labels": [f"{edge.left:,.2f}–{edge.right:,.2f}" for edge in grouped.index], "values": [int(value) for value in grouped.values], "series": "Rows"})
        for column in categorical[:max(0, 8 - len(charts))]:
            charts.append(count_chart(frame[column], f"{column} breakdown", "Rows", limit=10))
        if not charts:
            column = str(frame.columns[0])
            charts.append(count_chart(frame[column], f"{column} values", "Rows", limit=10))
        missing_cells = int(frame.isna().sum().sum())
        return {
            "title": "Spreadsheet overview",
            "subtitle": f"An adaptable dashboard for {len(frame):,} rows and {len(frame.columns)} columns.",
            "metrics": [
                {"label": "Rows", "value": f"{len(frame):,}"},
                {"label": "Columns", "value": f"{len(frame.columns):,}"},
                {"label": "Numeric fields", "value": f"{len(numeric):,}"},
                {"label": "Blank cells", "value": f"{missing_cells:,}"},
            ],
            "charts": charts,
            "note": "Charts use the columns found in this spreadsheet. Numeric fields are grouped into ranges; category charts show the most frequent values.",
        }

    credit = pd.to_numeric(frame["CreditScore"], errors="coerce").dropna()
    age = pd.to_numeric(frame["Age"], errors="coerce").dropna()
    tenure = pd.to_numeric(frame["Tenure"], errors="coerce").dropna()
    balance = pd.to_numeric(frame["Balance"], errors="coerce").dropna()
    products = pd.to_numeric(frame["NumOfProducts"], errors="coerce").dropna()
    exited = pd.to_numeric(frame["Exited"], errors="coerce").fillna(0)

    credit_bins = pd.cut(credit, bins=[0, 400, 500, 600, 700, 800, 1000], labels=["300–399", "400–499", "500–599", "600–699", "700–799", "800+"])
    age_bins = pd.cut(age, bins=[0, 29, 39, 49, 59, 69, 150], labels=["18–29", "30–39", "40–49", "50–59", "60–69", "70+"])
    balance_labels = ["0"]
    balance_values = [int((balance == 0).sum())]
    nonzero_balance = balance[balance > 0]
    if not nonzero_balance.empty:
        top = max(50_000, int((nonzero_balance.max() + 49_999) // 50_000) * 50_000)
        edges = list(range(0, top + 50_000, 50_000))
        buckets = pd.cut(nonzero_balance, bins=edges, right=True, include_lowest=True)
        bucket_counts = buckets.value_counts().sort_index()
        for interval, count in bucket_counts.items():
            balance_labels.append(f"{int(interval.left):,}–{int(interval.right):,}")
            balance_values.append(int(count))

    exited_labels = exited.map({0: "Stayed", 1: "Exited"}).fillna("Other")
    charts = [
        count_chart(frame["Geography"], "Customers by geography", "Customers"),
        count_chart(frame["NumOfProducts"], "Products per customer", "Customers", order="ascending"),
        count_chart(credit_bins, "Credit score distribution", "Customers"),
        count_chart(frame["Gender"], "Customers by gender", "Customers"),
        count_chart(age_bins, "Age distribution", "Customers"),
        count_chart(exited_labels, "Customer outcomes", "Customers"),
        count_chart(tenure, "Tenure distribution", "Customers", order="ascending"),
        {"title": "Balance distribution", "labels": balance_labels, "values": balance_values, "series": "Customers"},
    ]
    exited_count = int((exited == 1).sum())
    customers = len(frame)
    return {
        "title": "Customer overview",
        "subtitle": f"A snapshot of {customers:,} customers across geography, profile, and account activity.",
        "metrics": [
            {"label": "Customers", "value": f"{customers:,}"},
            {"label": "Exited", "value": f"{exited_count:,} ({exited_count / customers * 100:.1f}%)" if customers else "0"},
            {"label": "Average credit score", "value": f"{credit.mean():,.0f}" if not credit.empty else "—"},
            {"label": "Avg. products per customer", "value": f"{products.mean():.2f}" if not products.empty else "—"},
        ],
        "charts": charts,
        "note": "Customer counts use one row per customer. NumOfProducts is a separate product measure, so it is summarized as an average rather than used as a customer count.",
    }


@app.post("/api/spreadsheets/join")
def join_spreadsheets(request: JoinRequest) -> dict[str, Any]:
    left = get_dataset(request.left_file_id)
    right = get_dataset(request.right_file_id)
    if left is None or right is None:
        raise HTTPException(status_code=404, detail="One of those spreadsheets is no longer available. Reopen it from My files.")
    if request.left_on not in left.columns or request.right_on not in right.columns:
        raise HTTPException(status_code=422, detail="Choose a matching column from each spreadsheet.")
    if request.join_type not in {"inner", "left", "outer"}:
        raise HTTPException(status_code=422, detail="Choose an inner, left, or full outer join.")

    def key_counts(series: pd.Series) -> dict[Any, int]:
        counts: dict[Any, int] = {}
        for value, count in series.value_counts(dropna=False).items():
            key = ("__missing_key__",) if pd.isna(value) else value
            counts[key] = int(count)
        return counts

    left_counts = key_counts(left[request.left_on])
    right_counts = key_counts(right[request.right_on])
    matched_rows = sum(count * right_counts.get(key, 0) for key, count in left_counts.items())
    unmatched_left = sum(count for key, count in left_counts.items() if right_counts.get(key, 0) == 0)
    unmatched_right = sum(count for key, count in right_counts.items() if left_counts.get(key, 0) == 0)
    estimated_rows = matched_rows if request.join_type == "inner" else matched_rows + unmatched_left
    if request.join_type == "outer":
        estimated_rows += unmatched_right
    if estimated_rows > 1_000_000:
        raise HTTPException(status_code=413, detail="That match would create over one million rows. Choose a more specific matching key.")
    try:
        merged = pd.merge(left, right, left_on=request.left_on, right_on=request.right_on, how=request.join_type, suffixes=("_left", "_right"))
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=f"Those columns could not be matched: {exc}") from exc
    if merged.empty:
        raise HTTPException(status_code=422, detail="Those columns did not match any rows. Try different matching columns or a full outer join.")
    output = io.BytesIO()
    merged.to_csv(output, index=False)
    left_meta = json.loads(metadata_path(request.left_file_id).read_text(encoding="utf-8"))
    right_meta = json.loads(metadata_path(request.right_file_id).read_text(encoding="utf-8"))
    result = spreadsheet_result(f"Joined — {left_meta['filename']} + {right_meta['filename']}.csv", output.getvalue())
    result["join_sources"] = [left_meta["filename"], right_meta["filename"]]
    result["join_type"] = request.join_type
    result["join_columns"] = [request.left_on, request.right_on]
    result["unmatched_left_rows"] = unmatched_left
    result["unmatched_right_rows"] = unmatched_right
    meta_path = metadata_path(result["file_id"])
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.update({"join_sources": result["join_sources"], "join_type": request.join_type, "join_columns": result["join_columns"]})
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    return result


@app.post("/api/spreadsheets/profile")
def profile_spreadsheet(request: DashboardRequest) -> dict[str, Any]:
    frame = get_dataset(request.file_id)
    if frame is None:
        raise HTTPException(status_code=404, detail="This spreadsheet is no longer available. Please add it again.")

    columns = []
    for name in frame.columns:
        series = frame[name]
        present = series.notna() & series.astype("string").str.strip().fillna("").ne("")
        numeric = pd.to_numeric(series, errors="coerce")
        valid_numeric = numeric[present]
        non_numeric = max(0, int(present.sum()) - int(valid_numeric.notna().sum()))
        numeric_column = not valid_numeric.empty and non_numeric / max(int(present.sum()), 1) <= 0.1
        outliers = 0
        minimum = maximum = None
        if numeric_column:
            values = valid_numeric.dropna()
            minimum, maximum = float(values.min()), float(values.max())
            q1, q3 = values.quantile([0.25, 0.75])
            spread = q3 - q1
            outliers = int(((values < q1 - 1.5 * spread) | (values > q3 + 1.5 * spread)).sum()) if spread else 0
        missing = int((~present).sum())
        columns.append({
            "name": str(name),
            "kind": "numeric" if numeric_column else "category",
            "missing": missing,
            "missing_percent": round(missing / max(len(frame), 1) * 100, 1),
            "distinct": int(series[present].nunique()),
            "non_numeric": non_numeric if numeric_column else 0,
            "outliers": outliers,
            "minimum": minimum,
            "maximum": maximum,
        })

    missing_mask = frame.isna() | frame.astype("string").apply(lambda column: column.str.strip().fillna("").eq(""))
    row_missing = missing_mask.sum(axis=1)
    return {
        "row_count": int(len(frame)),
        "column_count": int(len(frame.columns)),
        "blank_cells": int(sum(column["missing"] for column in columns)),
        "rows_with_blanks": int((row_missing > 0).sum()),
        "duplicate_rows": int(frame.duplicated().sum()),
        "columns": columns,
    }


@app.post("/api/spreadsheets/ask")
def ask_spreadsheet(request: SpreadsheetQuestion) -> dict[str, Any]:
    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=422, detail="Enter a question about this spreadsheet.")
    frame = get_dataset(request.file_id)
    if frame is None:
        raise HTTPException(status_code=404, detail="That spreadsheet is no longer in memory. Please upload it again.")
    columns = [str(column) for column in frame.columns]
    if frame.empty:
        raise HTTPException(status_code=400, detail="This spreadsheet has no rows to analyze.")
    numeric = [column for column in columns if pd.api.types.is_numeric_dtype(pd.to_numeric(frame[column], errors="coerce"))]
    lowered = question.casefold()

    if any(word in lowered for word in ("chart", "plot", "graph", "visual")):
        value_column = find_column(columns, lowered, numeric)
        if not value_column or value_column not in numeric:
            value_column = numeric[0] if numeric else None
        label_columns = [column for column in columns if column != value_column and column not in numeric]
        if not value_column or not label_columns:
            raise HTTPException(status_code=422, detail="I need one category column and one numeric column to make that chart. Tell me which columns to use.")
        label_column = find_column(label_columns, lowered) or label_columns[0]
        frame[value_column] = pd.to_numeric(frame[value_column], errors="coerce")
        grouped = frame.groupby(label_column, dropna=False)[value_column].sum().sort_values(ascending=False).head(12)
        return {"answer": f"Here is {value_column} by {label_column}, using the 12 largest totals.", "chart": {"title": f"{value_column} by {label_column}", "labels": [str(item) for item in grouped.index], "values": [float(value) for value in grouped.values], "series": value_column}}

    if any(word in lowered for word in ("summary", "summarize", "overview", "describe")):
        numeric_summary = []
        for column in numeric:
            values = pd.to_numeric(frame[column], errors="coerce").dropna()
            if not values.empty:
                numeric_summary.append(f"{column}: average {values.mean():,.2f}, range {values.min():,.2f} to {values.max():,.2f}")
        summary = f"This file has {len(frame):,} rows and {len(columns)} columns: {', '.join(columns)}."
        if numeric_summary:
            summary += " " + " · ".join(numeric_summary)
        return {"answer": summary, "chart": None}

    if any(word in lowered for word in ("how many", "count", "number of rows", "row count")):
        return {"answer": f"There are {len(frame):,} rows in this spreadsheet.", "chart": None}

    operation = next((word for word in ("average", "mean", "sum", "total", "maximum", "highest", "max", "minimum", "lowest", "min") if word in lowered), None)
    if operation:
        column = find_column(columns, lowered, numeric)
        if column in numeric:
            values = pd.to_numeric(frame[column], errors="coerce").dropna()
            if not values.empty:
                if operation in ("maximum", "highest", "max", "minimum", "lowest", "min"):
                    row = frame.loc[pd.to_numeric(frame[column], errors="coerce").idxmax() if operation in ("maximum", "highest", "max") else pd.to_numeric(frame[column], errors="coerce").idxmin()]
                    categories = [name for name in columns if name != column and name not in numeric]
                    if categories:
                        return {"answer": f"{row[categories[0]]} has the {'highest' if operation in ('maximum', 'highest', 'max') else 'lowest'} {column} ({float(row[column]):,.2f}).", "chart": None}
                if operation in ("average", "mean"):
                    label, value = "Average", values.mean()
                elif operation in ("sum", "total"):
                    label, value = "Total", values.sum()
                elif operation in ("maximum", "highest", "max"):
                    label, value = "Highest value", values.max()
                else:
                    label, value = "Lowest value", values.min()
                return {"answer": f"{label} for {column}: {value:,.2f}.", "chart": None}

    context = frame.head(80).to_csv(index=False)
    model_prompt = f"Answer the user's question using only this spreadsheet data. Do not invent facts. If you need a chart, say what columns to plot but do not output a chart.\n\nQuestion: {question}\n\nData:\n{context}"
    try:
        return {"answer": model_text(model_prompt), "chart": None}
    except ModelProviderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def spreadsheet_result(name: str, data: bytes) -> dict[str, Any]:
    try:
        suffix = name.lower().rsplit(".", 1)[-1]
        if suffix == "tsv":
            frame = pd.read_csv(io.BytesIO(data), sep="\t")
        elif suffix == "csv":
            frame = pd.read_csv(io.BytesIO(data))
        else:
            frame = pd.read_excel(io.BytesIO(data), engine="odf" if suffix == "ods" else None)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read this spreadsheet: {exc}") from exc
    validate_spreadsheet_shape(frame)
    frame = frame.astype(object).where(pd.notna(frame), None)
    file_id = uuid.uuid4().hex
    extension = suffix
    (workspace_files() / f"{file_id}.{extension}").write_bytes(data)
    meta = {"file_id": file_id, "filename": name, "kind": "spreadsheet", "extension": extension, "row_count": int(len(frame)), "columns": [str(column) for column in frame.columns], "created_at": datetime.now(timezone.utc).isoformat()}
    metadata_path(file_id).write_text(json.dumps(meta), encoding="utf-8")
    datasets[file_id] = frame
    return {
        "filename": name,
        "file_id": file_id,
        "columns": [str(column) for column in frame.columns],
        "rows": frame.head(200).to_dict(orient="records"),
        "row_count": int(len(frame)),
        "preview_limit": 200,
        "kind": "spreadsheet",
    }


@app.get("/api/files")
def list_files() -> list[dict[str, Any]]:
    return file_metadata()


@app.get("/api/files/{file_id}")
def open_file(file_id: str) -> dict[str, Any]:
    meta_path = metadata_path(file_id)
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="That file could not be found in this workspace.")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="That file's metadata is unreadable.") from exc
    if meta.get("kind") == "spreadsheet":
        frame = get_dataset(file_id)
        if frame is None:
            raise HTTPException(status_code=500, detail="Could not reopen this spreadsheet.")
        return {**meta, "rows": frame.head(200).to_dict(orient="records"), "preview_limit": 200}
    content_path = workspace_files() / f"{file_id}.txt"
    try:
        text = content_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail="That file's content is unreadable.") from exc
    return {**meta, "text": text}


@app.delete("/api/files/{file_id}")
def remove_file(file_id: str) -> dict[str, str]:
    meta_path = metadata_path(file_id)
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="That file could not be found in this workspace.")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="That file's metadata is unreadable.") from exc
    payload_path = workspace_files() / (f"{file_id}.{meta['extension']}" if meta.get("kind") == "spreadsheet" else f"{file_id}.txt")
    payload_path.unlink(missing_ok=True)
    meta_path.unlink(missing_ok=True)
    datasets.pop(file_id, None)
    return {"status": "removed"}


@app.post("/api/spreadsheets/upload")
async def upload_spreadsheet(file: UploadFile = File(...)) -> dict[str, Any]:
    name = file.filename or "spreadsheet.csv"
    if not name.lower().endswith((".csv", ".tsv", ".xlsx", ".xlsm", ".xls", ".ods")):
        raise HTTPException(status_code=415, detail="Choose a CSV, TSV, or Excel file (.xlsx, .xlsm, .xls, .ods).")
    return spreadsheet_result(name, await read_upload(file, MAX_SPREADSHEET_BYTES))


@app.post("/api/spreadsheets/google")
def import_google_sheet(request: SheetsRequest) -> dict[str, Any]:
    match = re.match(r"^https://docs\.google\.com/spreadsheets/d/([\w-]+)(?:/.*)?(?:\?.*)?$", request.url.strip())
    if not match:
        raise HTTPException(status_code=400, detail="Paste a Google Sheets link beginning with https://docs.google.com/spreadsheets/d/ .")
    sheet_id = match.group(1)
    export_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv"
    try:
        req = urllib.request.Request(export_url, headers={"User-Agent": "ClarityDesk local app"})
        with urllib.request.urlopen(req, timeout=15) as response:
            data = response.read(MAX_GOOGLE_SHEET_BYTES + 1)
            if len(data) > MAX_GOOGLE_SHEET_BYTES:
                raise HTTPException(status_code=413, detail="Google Sheets imports must be smaller than 15 MB.")
            if "text/csv" not in response.headers.get("Content-Type", "") and not data.startswith((b"\xef\xbb\xbf",)) and b"," not in data[:500]:
                raise HTTPException(status_code=400, detail="This sheet is not publicly accessible. Publish it or allow access by link, then try again.")
        return spreadsheet_result("Google Sheets import.csv", data)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Could not read that Google Sheet. Make sure link access is enabled.") from exc


@app.post("/api/pdf/upload")
async def upload_pdf(file: UploadFile = File(...)) -> dict[str, Any]:
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="Choose a PDF document.")
    try:
        document = fitz.open(stream=await read_upload(file, MAX_PDF_BYTES), filetype="pdf")
        pages = [{"page": index + 1, "text": page.get_text("text")} for index, page in enumerate(document)]
        text = "\n\n".join(f"[Page {page['page']}]\n{page['text']}" for page in pages)
        document.close()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Could not read this PDF.") from exc
    if not text.strip():
        raise HTTPException(status_code=400, detail="This PDF has no selectable text. Scanned PDFs need OCR, which is not set up yet.")
    file_id = uuid.uuid4().hex
    meta = {"file_id": file_id, "filename": file.filename, "kind": "pdf", "pages": len(pages), "created_at": datetime.now(timezone.utc).isoformat()}
    (workspace_files() / f"{file_id}.txt").write_text(text[:80_000], encoding="utf-8")
    metadata_path(file_id).write_text(json.dumps(meta), encoding="utf-8")
    return {**meta, "text": text[:80_000]}


@app.post("/api/documents/upload")
async def upload_office_document(file: UploadFile = File(...)) -> dict[str, Any]:
    filename = file.filename or "document"
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension not in {"docx", "pptx"}:
        raise HTTPException(status_code=415, detail="Choose a modern Word (.docx) or PowerPoint (.pptx) file. Legacy .doc and .ppt files are not supported yet.")
    data = await read_upload(file, MAX_OFFICE_BYTES)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            if sum(member.file_size for member in members) > 100_000_000:
                raise HTTPException(status_code=413, detail="This Office document expands beyond the 100 MB processing limit.")
            if extension == "docx":
                xml_content = archive.read("word/document.xml")
                root = ET.fromstring(xml_content)
                paragraphs = []
                for paragraph in root.iter():
                    if paragraph.tag.endswith("}p"):
                        value = "".join(node.text or "" for node in paragraph.iter() if node.tag.endswith("}t"))
                        if value.strip():
                            paragraphs.append(value)
                text = "\n".join(paragraphs)
                count = len(paragraphs)
                document_type = "Word document"
                marker = "Paragraph"
            else:
                slide_names = [name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]
                slide_names.sort(key=lambda name: int(re.search(r"slide(\d+)", name).group(1)))
                slide_sections = []
                for slide_index, slide_name in enumerate(slide_names, 1):
                    root = ET.fromstring(archive.read(slide_name))
                    lines = ["".join(node.text or "" for node in paragraph.iter() if node.tag.endswith("}t")) for paragraph in root.iter() if paragraph.tag.endswith("}p") and "drawingml" in paragraph.tag]
                    lines = [line for line in lines if line.strip()]
                    if lines:
                        slide_sections.append(f"[Slide {slide_index}]\n" + "\n".join(lines))
                text = "\n\n".join(slide_sections)
                count = len(slide_names)
                document_type = "PowerPoint presentation"
                marker = "Slide"
    except HTTPException:
        raise
    except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Could not read this {extension.upper()} file. Make sure it is a valid Office document.") from exc
    if not text.strip():
        raise HTTPException(status_code=400, detail=f"This {document_type} contains no extractable text.")
    text = text[:160_000]
    file_id = uuid.uuid4().hex
    meta = {"file_id": file_id, "filename": filename, "kind": "document", "document_type": document_type, "extension": extension, "count": count, "count_label": "slides" if extension == "pptx" else "text sections", "created_at": datetime.now(timezone.utc).isoformat()}
    (workspace_files() / f"{file_id}.txt").write_text(text, encoding="utf-8")
    metadata_path(file_id).write_text(json.dumps(meta), encoding="utf-8")
    return {**meta, "text": text, "marker": marker}


@app.post("/api/pdf/ask")
def ask_pdf(request: PdfPrompt) -> dict[str, str]:
    if request.task not in {"custom", "summarize", "explain", "keypoints"}:
        raise HTTPException(status_code=422, detail="That document task is not supported.")
    try:
        return {"answer": model_text(request.prompt)}
    except ModelProviderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@app.get("/api/health")
def health_check() -> dict[str, Any]:
    if AI_PROVIDER == "gemini":
        model_state: dict[str, Any] = {"provider": "gemini", "status": "offline", "model_ready": False}
        if not GEMINI_API_KEY:
            model_state["reason"] = "GEMINI_API_KEY is not configured"
            return {"status": "ok", "service": "ClarityDesk", "ollama": model_state}
        try:
            request = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models?key={GEMINI_API_KEY}",
                headers={"User-Agent": "ClarityDesk health check"},
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                models = json.loads(response.read().decode("utf-8")).get("models", [])
            names = [str(item.get("name", "")).removeprefix("models/") for item in models]
            model_state.update({"status": "online", "model_ready": GEMINI_MODEL in names, "model": GEMINI_MODEL})
        except (OSError, TimeoutError, ValueError, TypeError):
            model_state["reason"] = "Gemini could not be reached"
        return {"status": "ok", "service": "ClarityDesk", "ollama": model_state}
    model_state: dict[str, Any] = {"provider": "ollama", "status": "offline", "model_ready": False}
    try:
        req = urllib.request.Request(f"{OLLAMA_BASE_URL}/api/tags", headers={"User-Agent": "ClarityDesk local health check"})
        with urllib.request.urlopen(req, timeout=0.6) as response:
            models = json.loads(response.read().decode("utf-8")).get("models", [])
        names = [str(item.get("name", "")) for item in models]
        model_state = {"provider": "ollama", "status": "online", "model_ready": any(name == OLLAMA_MODEL or name.startswith(f"{OLLAMA_MODEL}:") for name in names), "models": names}
    except (OSError, TimeoutError, ValueError):
        pass
    return {"status": "ok", "service": "ClarityDesk", "ollama": model_state}
