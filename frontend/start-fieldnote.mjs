import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(frontendDir, '..')
const backendDir = resolve(projectDir, 'backend')
const pythonExe = resolve(projectDir, '.venv', 'Scripts', 'python.exe')
const frontendUrl = 'http://127.0.0.1:5173'
const backendUrl = 'http://127.0.0.1:8000'

async function fetchJson(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

async function responds(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

async function waitFor(check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise((resolveWait) => setTimeout(resolveWait, 800))
  }
  return null
}

function startDetached(command, args, cwd, outName, errName) {
  const stdout = openSync(resolve(projectDir, outName), 'a')
  const stderr = openSync(resolve(projectDir, errName), 'a')
  try {
    const child = spawn(command, args, { cwd, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr] })
    child.on('error', (error) => console.error(`Could not start ${outName}: ${error.message}`))
    child.unref()
  } finally {
    closeSync(stdout)
    closeSync(stderr)
  }
}

const initialHealth = await fetchJson(`${backendUrl}/api/health`)
if (!initialHealth) {
  if (!existsSync(pythonExe)) {
    console.error('ClarityDesk’s Python environment is missing. Follow the setup instructions in README.md, then run this launcher again.')
    process.exit(1)
  }
  startDetached(pythonExe, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'], backendDir, 'backend.out.log', 'backend.err.log')
}

const health = await waitFor(() => fetchJson(`${backendUrl}/api/health`))
if (!health) {
  console.error('The ClarityDesk API did not start. Check backend.err.log and confirm port 8000 is available.')
  process.exit(1)
}

let webReady = await responds(`${frontendUrl}/`)
if (!webReady) {
  if (!existsSync(resolve(frontendDir, 'node_modules', 'vite'))) {
    console.error('Frontend packages are missing. Open a terminal in the frontend folder, run npm install, then try again.')
    process.exit(1)
  }
  if (process.platform === 'win32') {
    startDetached(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1'], frontendDir, 'frontend.out.log', 'frontend.err.log')
  } else {
    startDetached('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], frontendDir, 'frontend.out.log', 'frontend.err.log')
  }
  webReady = await waitFor(() => responds(`${frontendUrl}/`))
}

if (!webReady) {
  console.error('The ClarityDesk website did not start. Check frontend.err.log and confirm port 5173 is available.')
  process.exit(1)
}

let ollama = health.ollama || null
if (!ollama || ollama.status !== 'online') {
  const localOllama = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : ''
  if (localOllama && existsSync(localOllama)) {
    startDetached(localOllama, ['serve'], projectDir, 'ollama.out.log', 'ollama.err.log')
    const ollamaTags = await waitFor(() => fetchJson('http://127.0.0.1:11434/api/tags', 1000), 10000)
    ollama = ollamaTags ? { status: 'online', model_ready: ollamaTags.models?.some((model) => model.name === 'llama3.2' || model.name?.startsWith('llama3.2:')) } : { status: 'offline', model_ready: false }
  }
}

console.log('ClarityDesk is ready.')
console.log(`Website: ${frontendUrl}`)
console.log(`Analysis service: ${backendUrl}`)
if (ollama?.model_ready) console.log('Local AI: llama3.2 is ready for PDF questions.')
else if (ollama?.status === 'online') console.log('Local AI is running, but llama3.2 is not installed. Run “ollama run llama3.2” to add it.')
else console.log('Local AI is offline. Spreadsheet tools work; start Ollama to ask questions about PDFs.')
console.log('Service logs: backend.err.log and frontend.err.log')

if (process.platform === 'win32' && !process.argv.includes('--no-open')) {
  const browser = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', `${frontendUrl}/#overview`], { detached: true, windowsHide: false, stdio: 'ignore' })
  browser.unref()
}
