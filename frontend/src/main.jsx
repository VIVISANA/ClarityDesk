import React from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

const API = import.meta.env.VITE_API_BASE_URL || ''

function readStoredJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null')
    return value ?? fallback
  } catch {
    localStorage.removeItem(key)
    return fallback
  }
}

function apiFetch(url, options = {}) {
  const session = readStoredJson('fieldnote.session', null)
  const headers = new Headers(options.headers || {})
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`)
  return fetch(url, { ...options, headers }).then((response) => {
    if (response.status === 401) {
      localStorage.removeItem('fieldnote.session')
      window.dispatchEvent(new CustomEvent('fieldnote:session-expired'))
    }
    return response
  })
}

function getWorkspaceSession() {
  const session = readStoredJson('fieldnote.session', null)
  if (session?.email && session?.access_token) return session
  if (session) localStorage.removeItem('fieldnote.session')
  return null
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256)
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function AuthScreen({ onLogin }) {
  const [mode, setMode] = React.useState('signin')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  async function submit(event) {
    event.preventDefault()
    setError('')
    setBusy(true)
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') || '').trim()
    const email = String(form.get('email') || '').trim().toLowerCase()
    const password = String(form.get('password') || '')
    try {
      const authAction = mode === 'signin' ? 'login' : 'signup'
      let response = await fetch(`${API}/api/auth/${authAction}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password }) })
      let result = await response.json()
      if (!response.ok && mode === 'signin') {
        const oldAccounts = readStoredJson('fieldnote.accounts', {})
        const oldAccount = oldAccounts[email]
        if (oldAccount && oldAccount.hash === await passwordHash(password, oldAccount.salt)) {
          response = await fetch(`${API}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: oldAccount.name || name, email, password }) })
          result = await response.json()
          if (response.ok) { delete oldAccounts[email]; localStorage.setItem('fieldnote.accounts', JSON.stringify(oldAccounts)) }
        }
      }
      if (!response.ok) throw new Error(result.detail || 'Could not open your workspace.')
      const user = result
      localStorage.setItem('fieldnote.session', JSON.stringify(user))
      onLogin(user)
    } catch (err) { setError(err.message || 'Could not open your workspace.') }
    finally { setBusy(false) }
  }

  return <main className="auth-page">
    <section className="auth-story"><a className="brand auth-brand" href="#home"><span className="brand-mark"><span /></span><span>ClarityDesk</span></a>
      <div className="story-copy"><span className="story-kicker">A QUIETER WAY TO WORK WITH DATA</span><h1>Good questions<br />make better work.</h1><p>A thoughtful place to explore your spreadsheets, read your documents, and find the details that matter.</p>
        <div className="story-bottom"><div className="story-line"/><span>Made for curious minds.</span><span className="story-flower">✳</span></div>
      </div>
      <span className="story-footnote">YOUR WORKSPACE, ON THIS DEVICE</span>
    </section>
    <section className="auth-side"><div className="auth-form-wrap"><div className="mobile-brand"><a className="brand" href="#home"><span className="brand-mark"><span /></span><span>ClarityDesk</span></a></div>
      <span className="auth-kicker">YOUR PERSONAL WORKSPACE</span><h2>{mode === 'signin' ? 'Welcome back.' : 'Make yourself at home.'}</h2><p className="auth-subtitle">{mode === 'signin' ? 'Sign in to pick up where you left off.' : 'Create a workspace just for you.'}</p>
      <form onSubmit={submit} className="auth-form">
        {mode === 'signup' && <label>Your name<input name="name" autoComplete="name" placeholder="How should we greet you?" required /></label>}
        <label>Email address<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></label>
        <label>Password<input name="password" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} placeholder="At least 8 characters" minLength={8} required /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : 'Create workspace'}<span>→</span></button>
      </form>
      <p className="auth-switch">{mode === 'signin' ? 'New to ClarityDesk?' : 'Already have a workspace?'} <button onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError('') }}>{mode === 'signin' ? 'Create an account' : 'Sign in'}</button></p>
      <p className="local-explainer"><span>⌂</span> Accounts and files stay on this device. Each account has its own private workspace.</p>
    </div><footer className="auth-footer"><span>FIELDNOTE</span><span>Room for the useful details.</span></footer></section>
  </main>
}

function Chart({ chart }) {
  const labels = chart.labels || []
  const values = labels.map((_, index) => Math.max(0, Number(chart.values?.[index]) || 0))
  const maxValue = Math.max(...values, 1)
  const step = Math.pow(10, Math.floor(Math.log10(maxValue))) / 2 || 1
  const axisMax = Math.ceil(maxValue / step) * step || 1
  const width = 520, height = 285
  const margin = { top: 20, right: 16, bottom: 58, left: 52 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const slot = plotWidth / Math.max(labels.length, 1)
  const barWidth = Math.min(42, Math.max(10, slot * 0.58))
  const ticks = Array.from({ length: 5 }, (_, index) => axisMax * index / 4)
  const numberLabel = (value) => new Intl.NumberFormat('en', { notation: value >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
  return <div className="chart-output"><h3>{chart.title}</h3>{labels.length ? <div className="graph-frame"><svg className="data-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${chart.title}, ${chart.series || 'values'} by category`}>
    {ticks.map((tick, index) => {
      const y = margin.top + plotHeight - (tick / axisMax) * plotHeight
      return <g key={`tick-${index}`}><line className="graph-gridline" x1={margin.left} x2={width - margin.right} y1={y} y2={y} /><text className="graph-tick" x={margin.left - 9} y={y + 4} textAnchor="end">{numberLabel(tick)}</text></g>
    })}
    <line className="graph-axis" x1={margin.left} x2={margin.left} y1={margin.top} y2={margin.top + plotHeight} />
    <line className="graph-axis" x1={margin.left} x2={width - margin.right} y1={margin.top + plotHeight} y2={margin.top + plotHeight} />
    <text className="graph-axis-title" transform={`translate(14 ${margin.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">{chart.series || 'Count'}</text>
    {labels.map((label, index) => {
      const value = values[index]
      const barHeight = (value / axisMax) * plotHeight
      const x = margin.left + index * slot + (slot - barWidth) / 2
      const y = margin.top + plotHeight - barHeight
      const fullLabel = String(label)
      const parts = fullLabel.length > 13 ? [fullLabel.slice(0, 12) + '…'] : fullLabel.split(/\s+/).slice(0, 2)
      return <g key={`${fullLabel}-${index}`}>
        <title>{`${fullLabel}: ${Number(value).toLocaleString()}${chart.series ? ` ${chart.series.toLowerCase()}` : ''}`}</title>
        <rect className="graph-bar" x={x} y={y} width={barWidth} height={Math.max(0, barHeight)} rx="3" />
        <text className="graph-value" x={x + barWidth / 2} y={Math.max(margin.top + 11, y - 6)} textAnchor="middle">{numberLabel(value)}</text>
        <text className="graph-category" x={x + barWidth / 2} y={margin.top + plotHeight + 17} textAnchor="middle">{parts.map((part, partIndex) => <tspan key={partIndex} x={x + barWidth / 2} dy={partIndex ? 11 : 0}>{part}</tspan>)}</text>
      </g>
    })}
  </svg></div> : <p className="graph-empty">No chart values to display.</p>}</div>
}

function Dashboard({ dashboard, onSave }) {
  return <section className="dashboard-section">
    <div className="dashboard-heading"><div><span className="section-kicker">A FIRST LOOK AT YOUR DATA</span><h2>{dashboard.title}</h2><p>{dashboard.subtitle} Charts are built from the full spreadsheet.</p></div><div className="dashboard-tools"><span className="dashboard-mark">FIELDNOTE / INSIGHTS</span><button className="build-dashboard" onClick={onSave}>Save this dashboard</button></div></div>
    <div className="dashboard-metrics">{dashboard.metrics.map((metric) => <article className="metric-card" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></article>)}</div>
    <div className="dashboard-grid">{dashboard.charts.map((chart) => <article className="dashboard-panel" key={chart.title}><Chart chart={chart} /></article>)}</div>
    <p className="dashboard-note">{dashboard.note}</p>
  </section>
}

function DataQualityPanel({ profile, loading, error }) {
  const flagged = profile?.columns?.filter((column) => column.missing || column.non_numeric || column.outliers) || []
  return <details className="data-quality">
    <summary><span>Data quality</span><span>{loading ? 'Checking…' : profile ? `${profile.blank_cells.toLocaleString()} blanks · ${profile.duplicate_rows.toLocaleString()} duplicate rows` : 'Review this file'}</span></summary>
    {loading ? <p className="quality-hint">Checking missing values, duplicates, mixed types, and possible outliers…</p> : error ? <p className="quality-hint quality-error">{error}</p> : profile && <>
      <div className="quality-metrics"><div><strong>{profile.row_count.toLocaleString()}</strong><span>Rows</span></div><div><strong>{profile.column_count}</strong><span>Columns</span></div><div><strong>{profile.blank_cells.toLocaleString()}</strong><span>Blank cells</span></div><div><strong>{profile.duplicate_rows.toLocaleString()}</strong><span>Duplicate rows</span></div></div>
      {flagged.length ? <div className="quality-columns"><strong>Items to review</strong>{flagged.slice(0, 8).map((column) => <p key={column.name}><b>{column.name}</b><span>{column.missing ? `${column.missing} missing (${column.missing_percent}%) · ` : ''}{column.non_numeric ? `${column.non_numeric} non-numeric value${column.non_numeric === 1 ? '' : 's'} · ` : ''}{column.outliers ? `${column.outliers} possible outlier${column.outliers === 1 ? '' : 's'}` : ''}</span></p>)}{flagged.length > 8 && <small>And {flagged.length - 8} more columns.</small>}</div> : <p className="quality-hint">No missing values, duplicate rows, or numeric outliers were detected.</p>}
      <p className="quality-footnote">Outliers are review suggestions based on the 1.5× IQR rule, not automatic errors.</p>
    </>}
  </details>
}

function App() {
  const [user, setUser] = React.useState(() => readStoredJson('fieldnote.session', null))
  const [view, setView] = React.useState(() => ['files', 'saved'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview')
  const [files, setFiles] = React.useState([])
  const [pdf, setPdf] = React.useState(null)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [sheetUrl, setSheetUrl] = React.useState('')
  const [answer, setAnswer] = React.useState('')
  const [data, setData] = React.useState(null)
  const [dataAnswer, setDataAnswer] = React.useState(null)
  const [dashboard, setDashboard] = React.useState(null)
  const [savedWork, setSavedWork] = React.useState(() => {
    const email = readStoredJson('fieldnote.session', null)?.email || 'guest'
    return readStoredJson(`fieldnote.saved.${email}`, [])
  })
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const spreadsheetPicker = React.useRef(null)
  const pdfPicker = React.useRef(null)
  const allFilesPicker = React.useRef(null)

  React.useEffect(() => {
    const syncView = () => setView(['files', 'saved'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview')
    window.addEventListener('hashchange', syncView)
    return () => window.removeEventListener('hashchange', syncView)
  }, [])

  React.useEffect(() => {
    if (!user) return
    apiFetch(`${API}/api/files`).then((response) => response.json()).then(setFiles).catch(() => setNotice('Could not load your local file list.'))
    setSavedWork(readStoredJson(`fieldnote.saved.${user.email}`, []))
  }, [user?.email])

  if (!user) return <AuthScreen onLogin={setUser} />

  async function loadFiles(selectedFiles) {
    const incoming = Array.from(selectedFiles || [])
    if (!incoming.length) return
    setBusy(true); setNotice(`Adding ${incoming.length} ${incoming.length === 1 ? 'file' : 'files'}…`)
    const added = []
    try {
      for (const file of incoming) {
        const body = new FormData(); body.append('file', file)
        const isPdf = file.name.toLowerCase().endsWith('.pdf')
        const response = await apiFetch(`${API}${isPdf ? '/api/pdf/upload' : '/api/spreadsheets/upload'}`, { method: 'POST', body })
        const result = await response.json(); if (!response.ok) throw new Error(`${file.name}: ${result.detail}`)
        added.push(result)
        const { text, rows, ...record } = result
        setFiles((current) => [record, ...current])
      }
      const newestSheet = [...added].reverse().find((file) => file.kind === 'spreadsheet')
      const newestPdf = [...added].reverse().find((file) => file.kind === 'pdf')
      if (newestSheet) { setData(newestSheet); setDataAnswer(null); setDashboard(null) }
      if (newestPdf) { setPdf(newestPdf); setAnswer('') }
      setNotice(`${added.length} ${added.length === 1 ? 'file' : 'files'} added to My files.`)
    } catch (error) { setNotice(error.message || 'Could not add those files.') }
    finally { setBusy(false) }
  }

  async function openFile(fileId) {
    setBusy(true); setNotice('Opening your file…')
    try {
      const response = await apiFetch(`${API}/api/files/${fileId}`)
      const result = await response.json(); if (!response.ok) throw new Error(result.detail)
      if (result.kind === 'spreadsheet') { setData(result); setDataAnswer(null); setDashboard(null); setPdf(null) }
      else { setPdf(result); setAnswer(''); setData(null); setDashboard(null) }
      setView('overview'); location.hash = '#overview'; setNotice(`${result.filename} is ready.`)
    } catch (error) { setNotice(error.message || 'Could not open that file.') }
    finally { setBusy(false) }
  }

  async function askPdf(task, custom) {
    if (!pdf) return
    const request = custom || ({ summarize: 'Summarize this document. Cover the main ideas, key findings, and any conclusions.', explain: 'Explain the main ideas in this document in clear, plain language.', keypoints: 'List the most important points in this document.' }[task])
    setBusy(true); setAnswer(''); setNotice('Working on your document…')
    try {
      const response = await apiFetch(`${API}/api/pdf/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, prompt: `${request}\n\nUse only the PDF text below. Refer to page numbers when useful. If the answer is not in the document, say so.\n\n${pdf.text}` }) })
      const result = await response.json(); if (!response.ok) throw new Error(result.detail)
      setAnswer(result.answer); setNotice('Finished. Answers are based on the selected PDF.')
    } catch (error) { setNotice(error.message || 'Could not complete the request.') }
    finally { setBusy(false) }
  }

  async function importSheet(event) {
    event.preventDefault(); setBusy(true); setNotice('Connecting to the sheet…')
    try {
      const response = await apiFetch(`${API}/api/spreadsheets/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sheetUrl }) })
      const result = await response.json(); if (!response.ok) throw new Error(result.detail)
      setData(result); setPdf(null); setDashboard(null); setFiles((current) => [(({ text, rows, ...file }) => file)(result), ...current]); setSheetOpen(false); setNotice(`${result.row_count.toLocaleString()} rows added to My files.`)
    } catch (error) { setNotice(error.message || 'Could not import that sheet.') }
    finally { setBusy(false) }
  }

  async function askData(event) {
    event.preventDefault()
    const question = new FormData(event.currentTarget).get('question')
    if (!question || !data) return
    if (/\bdashboard\b/i.test(question)) {
      await buildDashboard()
      return
    }
    setBusy(true); setNotice('Thinking about what you asked…'); setDataAnswer(null)
    try {
      const response = await apiFetch(`${API}/api/spreadsheets/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, file_id: data.file_id }) })
      const result = await response.json(); if (!response.ok) throw new Error(result.detail)
      setDataAnswer(result); setNotice(result.chart ? 'Done. I added a chart because you asked for one.' : 'Done. Here is what I found.')
    } catch (error) { setNotice(error.message || 'Could not answer that question.') }
    finally { setBusy(false) }
  }

  async function buildDashboard() {
    if (!data) return
    setBusy(true); setNotice('Building views from the full spreadsheet…'); setDataAnswer(null)
    try {
      const response = await apiFetch(`${API}/api/spreadsheets/dashboard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: data.file_id }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not build the dashboard. Please upload the spreadsheet again.')
      setDashboard(result); setNotice('Your dashboard is ready.')
    } catch (error) { setNotice(error.message || 'Could not build the dashboard.') }
    finally { setBusy(false) }
  }

  function saveDashboard() {
    if (!dashboard || !data) return
    const item = { id: crypto.randomUUID(), kind: 'dashboard', title: dashboard.title, filename: data.filename, saved_at: new Date().toISOString(), dashboard }
    const next = [item, ...savedWork]
    setSavedWork(next); localStorage.setItem(`fieldnote.saved.${user.email}`, JSON.stringify(next)); setNotice('Dashboard saved to Saved work.')
  }

  const today = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase()
  return <div className="app-frame">
    <aside className="sidebar">
      <a className="brand" href="#home" aria-label="ClarityDesk home"><span className="brand-mark"><span /></span><span>ClarityDesk</span></a>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="Main navigation"><a className={`nav-item ${view === 'overview' ? 'selected' : 'muted'}`} href="#overview"><span className="nav-icon grid-icon">▦</span>Overview</a><a className={`nav-item ${view === 'files' ? 'selected' : 'muted'}`} href="#files"><span className="nav-icon">▤</span>My files</a><a className={`nav-item ${view === 'saved' ? 'selected' : 'muted'}`} href="#saved"><span className="nav-icon">☆</span>Saved work</a></nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="note-icon">✳</span><div><strong>A little more clarity.</strong><span>Your data workspace, at your pace.</span></div></div><div className="profile"><div className="avatar">{user.name?.slice(0, 1).toUpperCase() || 'Y'}</div><div><strong>{user.name || 'Your workspace'}</strong><span>{user.email}</span></div><button className="signout" onClick={() => { localStorage.removeItem('fieldnote.session'); setUser(null) }}>Sign out</button></div></div>
    </aside>
    <main className="main-area" id="overview">
      <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> {view === 'files' ? 'My files' : view === 'saved' ? 'Saved work' : 'Overview'}</div><div className="top-actions"><button className="help-button" aria-label="Help">?</button></div></header>
      <div className="page-content">
        {view === 'overview' && <>
        <section className="welcome-row"><div><p className="eyebrow">{today}</p><h1>Good evening{user.name ? `, ${user.name.split(' ')[0]}` : ''}.</h1><p className="intro">What would you like to understand today?</p></div><div className="date-mark"><span>YOUR SPACE</span><strong>01</strong><i /></div></section>
        <section className="start-section"><div className="section-heading"><div><span className="section-kicker">GET STARTED</span><h2>Bring your data into focus</h2></div><span className="step-count">01 <i>—</i> 03</span></div>
          <div className="start-grid">
            <button className="source-card csv-card" onClick={() => spreadsheetPicker.current?.click()} disabled={busy}><span className="card-arrow">↗</span><span className="file-icon csv-icon">▥</span><span className="source-type">SPREADSHEET</span><strong>Explore a file</strong><span className="source-desc">CSV, TSV, Excel, or OpenDocument. Find patterns and compare numbers.</span><span className="card-action">Choose a file <b>→</b></span></button>
            <button className="source-card pdf-card" onClick={() => pdfPicker.current?.click()} disabled={busy}><span className="card-arrow">↗</span><span className="file-icon pdf-icon">≡</span><span className="source-type">DOCUMENT</span><strong>Ask a PDF</strong><span className="source-desc">Summarize, explain, or ask your own question.</span><span className="card-action">Choose a PDF <b>→</b></span></button>
            <button className="source-card sheet-card" onClick={() => setSheetOpen(true)} disabled={busy}><span className="card-arrow">↗</span><span className="file-icon sheet-icon">▦</span><span className="source-type">GOOGLE SHEETS</span><strong>Bring in a sheet</strong><span className="source-desc">Paste a link to a sheet shared for access by link.</span><span className="card-action">Paste a link <b>→</b></span></button>
          </div>
          <input ref={spreadsheetPicker} type="file" multiple accept=".csv,.tsv,.xlsx,.xlsm,.xls,.ods" hidden onChange={(e) => { loadFiles(e.target.files); e.target.value = '' }} />
          <input ref={pdfPicker} type="file" multiple accept="application/pdf,.pdf" hidden onChange={(e) => { loadFiles(e.target.files); e.target.value = '' }} />
          <div className="privacy-note"><span>✳</span><p><strong>Your files stay in this workspace.</strong> PDF answers and open-ended spreadsheet questions use the free local model. No cloud AI is used.</p></div>
        </section>
        {notice && <div className="notice" role="status">{busy && <span className="spinner" />}{notice}</div>}
        {pdf && <section className="result-panel"><div className="result-head"><div><span className="section-kicker">DOCUMENT READY</span><h2>{pdf.filename}</h2></div><span className="page-pill">{pdf.pages} {pdf.pages === 1 ? 'page' : 'pages'}</span></div><div className="pdf-actions"><button onClick={() => askPdf('summarize')} disabled={busy}>Summarize</button><button onClick={() => askPdf('explain')} disabled={busy}>Explain simply</button><button onClick={() => askPdf('keypoints')} disabled={busy}>Key points</button></div><form className="custom-prompt" onSubmit={(e) => { e.preventDefault(); const value = new FormData(e.currentTarget).get('prompt'); if (value) askPdf('custom', value) }}><label htmlFor="pdf-prompt">Or tell ClarityDesk what you need</label><div><input id="pdf-prompt" name="prompt" placeholder="e.g. What are the report's recommendations?" required /><button disabled={busy}>Ask →</button></div></form>{answer && <div className="answer-box"><span className="section-kicker">FROM YOUR DOCUMENT</span><p>{answer}</p></div>}</section>}
        {data && <section className="result-panel"><div className="result-head"><div><span className="section-kicker">SPREADSHEET READY</span><h2>{data.filename}</h2></div><div className="sheet-actions"><span className="page-pill">{data.row_count.toLocaleString()} rows</span><button className="build-dashboard" onClick={buildDashboard} disabled={busy}>{busy ? 'Building…' : 'Build dashboard'} <span>↗</span></button></div></div><div className="table-wrap"><table><thead><tr>{data.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{data.rows.slice(0, 8).map((row, index) => <tr key={index}>{data.columns.map((column) => <td key={column}>{String(row[column] ?? '—')}</td>)}</tr>)}</tbody></table></div><p className="table-foot">Previewing up to 8 of {data.row_count.toLocaleString()} rows.</p>
          <form className="data-question" onSubmit={askData}><label htmlFor="data-question">What would you like to find out?</label><p>Ask for a summary, a total, a comparison, or a chart. ClarityDesk will follow your lead.</p><div><input id="data-question" name="question" placeholder="e.g. Which month had the highest revenue?" required /><button disabled={busy}>{busy ? 'Working…' : 'Ask ClarityDesk →'}</button></div></form>
          {dataAnswer && <div className="answer-box"><span className="section-kicker">YOUR ANSWER</span><p>{dataAnswer.answer}</p>{dataAnswer.chart && <Chart chart={dataAnswer.chart} />}</div>}
        </section>}
        {dashboard && <Dashboard dashboard={dashboard} onSave={saveDashboard} />}
        {!pdf && !data && <section className="recent-section"><div className="section-heading recent-heading"><div><span className="section-kicker">PICK UP WHERE YOU LEFT OFF</span><h2>Recent work</h2></div><a href="#files">All files <span>→</span></a></div>{files.length ? <div className="recent-empty"><div className="empty-doodle">▤</div><div><strong>{files.length} {files.length === 1 ? 'file' : 'files'} in your workspace</strong><p>Open My files to continue working with them.</p></div><a href="#files" className="empty-index">Open →</a></div> : <div className="recent-empty"><div className="empty-doodle"><span>↗</span></div><div><strong>A fresh page</strong><p>Your recent analyses will find a home here.</p></div><span className="empty-index">—</span></div>}</section>}
        </>}
        {view === 'files' && <section className="library-page"><div className="library-title"><div><span className="section-kicker">YOUR WORKSPACE</span><h1>My files</h1><p>Files added here stay on this device and are ready whenever you return.</p></div><button className="build-dashboard" onClick={() => { allFilesPicker.current?.click() }} disabled={busy}>＋ Add files</button><input ref={allFilesPicker} type="file" multiple accept=".pdf,application/pdf,.csv,.tsv,.xlsx,.xlsm,.xls,.ods" hidden onChange={(e) => { loadFiles(e.target.files); e.target.value = '' }} /></div>
          <div className="library-add-row"><button onClick={() => pdfPicker.current?.click()} disabled={busy}>＋ Add PDFs</button><input ref={pdfPicker} type="file" multiple accept="application/pdf,.pdf" hidden onChange={(e) => { loadFiles(e.target.files); e.target.value = '' }} /><span>Supported: CSV, TSV, Excel, OpenDocument, PDF and public Google Sheets.</span></div>
          {files.length ? <div className="file-list">{files.map((file) => <article className="file-item" key={file.file_id}><span className={`file-icon ${file.kind === 'pdf' ? 'pdf-icon' : file.filename?.toLowerCase().includes('google') ? 'sheet-icon' : 'csv-icon'}`}>{file.kind === 'pdf' ? '≡' : '▥'}</span><div className="file-info"><strong>{file.filename}</strong><span>{file.kind === 'pdf' ? `PDF · ${file.pages} ${file.pages === 1 ? 'page' : 'pages'}` : `${file.row_count?.toLocaleString()} rows · ${file.columns?.length || 0} columns`}</span></div><button onClick={() => openFile(file.file_id)} disabled={busy}>Open <span>→</span></button></article>)}</div> : <div className="recent-empty"><div className="empty-doodle">▤</div><div><strong>Your file library is ready</strong><p>Add more than one spreadsheet or PDF to keep your work together here.</p></div></div>}
        </section>}
        {view === 'saved' && <section className="library-page"><div className="library-title"><div><span className="section-kicker">YOUR WORKSPACE</span><h1>Saved work</h1><p>Keep dashboards close so you can revisit the findings that matter.</p></div><span className="page-pill">{savedWork.length} saved</span></div>
          {savedWork.length ? <div className="file-list">{savedWork.map((item) => <article className="file-item saved-item" key={item.id}><span className="file-icon sheet-icon">▦</span><div className="file-info"><strong>{item.title}</strong><span>{item.filename} · Saved {new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(item.saved_at))}</span></div><button onClick={() => { setDashboard(item.dashboard); setData({ filename: item.filename }); setView('overview'); location.hash = '#overview' }}>Open <span>→</span></button></article>)}</div> : <div className="recent-empty"><div className="empty-doodle">☆</div><div><strong>No saved work yet</strong><p>Build a dashboard from a spreadsheet, then choose “Save this dashboard.”</p></div></div>}
        </section>}
        <footer className="page-footer"><span>FIELDNOTE</span><span>Make room for the useful details.</span><span className="footer-status">Private by design</span></footer>
      </div>
    </main>
    {sheetOpen && <div className="modal-backdrop" onClick={() => setSheetOpen(false)}><section className="sheet-modal" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={(e) => e.stopPropagation()}><button className="modal-close" aria-label="Close" onClick={() => setSheetOpen(false)}>×</button><span className="file-icon sheet-icon">▦</span><span className="section-kicker">GOOGLE SHEETS</span><h2 id="sheet-title">Bring in a sheet</h2><p>Paste a link to a Google Sheet with access set to “Anyone with the link.” The sheet is imported as a CSV preview.</p><form onSubmit={importSheet}><label htmlFor="sheet-url">Sheet link</label><input id="sheet-url" type="url" placeholder="https://docs.google.com/spreadsheets/d/…" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} required /><button className="primary-button" disabled={busy}>Import sheet <span>→</span></button></form><span className="modal-footnote">Private sheets and Google sign-in are not connected in this local version.</span></section></div>}
  </div>
}

function AppV2() {
  const initialUser = getWorkspaceSession()
  const [user, setUser] = React.useState(initialUser)
  const initialPage = ['files', 'saved', 'analysis'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview'
  const [view, setView] = React.useState(initialPage)
  const [files, setFiles] = React.useState([])
  const [threads, setThreads] = React.useState(() => readStoredJson(`fieldnote.threads.${initialUser?.email || 'guest'}`, []))
  const [hydratedEmail, setHydratedEmail] = React.useState(initialUser?.email || null)
  const [activeId, setActiveId] = React.useState(null)
  const [savedWork, setSavedWork] = React.useState(() => readStoredJson(`fieldnote.saved.${initialUser?.email || 'guest'}`, []))
  const [data, setData] = React.useState(null)
  const [qualityProfile, setQualityProfile] = React.useState(null)
  const [qualityLoading, setQualityLoading] = React.useState(false)
  const [qualityError, setQualityError] = React.useState('')
  const [pdf, setPdf] = React.useState(null)
  const [question, setQuestion] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [serviceStatus, setServiceStatus] = React.useState(null)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [sheetUrl, setSheetUrl] = React.useState('')
  const [joinFileId, setJoinFileId] = React.useState('')
  const [joinLeft, setJoinLeft] = React.useState('')
  const [joinRight, setJoinRight] = React.useState('')
  const [joinType, setJoinType] = React.useState('inner')
  const filePicker = React.useRef(null)
  const pdfPicker = React.useRef(null)
  const mixedPicker = React.useRef(null)
  const backupPicker = React.useRef(null)
  const thread = threads.find((item) => item.id === activeId)
  const activeFiles = (thread?.file_ids || []).map((id) => files.find((file) => file.file_id === id)).filter(Boolean)
  const spreadsheetFiles = files.filter((file) => file.kind === 'spreadsheet')
  const otherJoinFiles = spreadsheetFiles.filter((file) => file.file_id !== data?.file_id)
  const rightFile = spreadsheetFiles.find((file) => file.file_id === joinFileId)

  React.useEffect(() => {
    const onHash = () => setView(['files', 'saved', 'analysis'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  React.useEffect(() => {
    if (!user) return
    const expireSession = () => setUser(null)
    window.addEventListener('fieldnote:session-expired', expireSession)
    apiFetch(`${API}/api/files`).then((response) => response.json()).then(setFiles).catch(() => setNotice('Could not load the local file library.'))
    setThreads(readStoredJson(`fieldnote.threads.${user.email}`, []))
    setSavedWork(readStoredJson(`fieldnote.saved.${user.email}`, []))
    setHydratedEmail(user.email)
    return () => window.removeEventListener('fieldnote:session-expired', expireSession)
  }, [user?.email])
  React.useEffect(() => {
    if (!user || hydratedEmail !== user.email) return
    try { localStorage.setItem(`fieldnote.threads.${user.email}`, JSON.stringify(threads)) }
    catch { setNotice('Browser storage is full. Download a workspace backup before continuing.') }
  }, [threads, user?.email, hydratedEmail])
  React.useEffect(() => {
    if (!user) return
    let cancelled = false
    const refresh = async () => {
      try {
        const response = await apiFetch(`${API}/api/health`)
        const result = await response.json()
        if (!response.ok) throw new Error('The local analysis service is offline.')
        if (!cancelled) setServiceStatus(result)
      } catch {
        if (!cancelled) setServiceStatus({ status: 'offline', ollama: { status: 'offline', model_ready: false } })
      }
    }
    refresh()
    const interval = window.setInterval(refresh, 12000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [user?.email])
  React.useEffect(() => {
    if (!data?.file_id) { setQualityProfile(null); setQualityError(''); return }
    const controller = new AbortController()
    setQualityProfile(null); setQualityError(''); setQualityLoading(true)
    apiFetch(`${API}/api/spreadsheets/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: data.file_id }), signal: controller.signal })
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.detail || 'Could not profile this file.'); return result })
      .then((result) => setQualityProfile(result))
      .catch((error) => { if (error.name !== 'AbortError') setQualityError(error.message || 'Could not check data quality.') })
      .finally(() => { if (!controller.signal.aborted) setQualityLoading(false) })
    return () => controller.abort()
  }, [data?.file_id])
  React.useEffect(() => {
    if (!joinFileId && otherJoinFiles.length) setJoinFileId(otherJoinFiles[0].file_id)
  }, [data?.file_id, files.length])

  function go(page) { setView(page); location.hash = `#${page}` }
  function updateThread(id, transform) {
    setThreads((current) => current.map((item) => item.id === id ? transform(item) : item))
  }
  function appendMessage(id, message) {
    updateThread(id, (item) => ({ ...item, updated_at: new Date().toISOString(), messages: [...item.messages, { ...message, id: crypto.randomUUID(), created_at: new Date().toISOString() }] }))
  }
  function attachFileId(id, fileId) {
    updateThread(id, (item) => ({ ...item, active_file_id: fileId, file_ids: [...new Set([...(item.file_ids || []), fileId])] }))
  }

  async function uploadFiles(selection) {
    const incoming = Array.from(selection || [])
    if (!incoming.length) return
    setBusy(true); setNotice(`Adding ${incoming.length} ${incoming.length === 1 ? 'file' : 'files'} to My files…`)
    try {
      let addedCount = 0
      for (const file of incoming) {
        const extension = file.name.toLowerCase().split('.').pop()
        const isPdf = extension === 'pdf'
        const isOfficeDocument = ['docx', 'pptx'].includes(extension)
        const body = new FormData(); body.append('file', file)
        const endpoint = isPdf ? '/api/pdf/upload' : isOfficeDocument ? '/api/documents/upload' : '/api/spreadsheets/upload'
        const response = await apiFetch(`${API}${endpoint}`, { method: 'POST', body })
        const result = await response.json(); if (!response.ok) throw new Error(`${file.name}: ${result.detail}`)
        const { text, rows, ...record } = result
        setFiles((current) => [record, ...current])
        if (thread) attachFileId(thread.id, record.file_id)
        addedCount += 1
      }
      setNotice(`${addedCount} ${addedCount === 1 ? 'file' : 'files'} added. Choose Analyze from My files to start working.`)
    } catch (error) { setNotice(error.message || 'Could not add those files.') }
    finally { setBusy(false) }
  }

  async function startAnalysis(fileId) {
    setBusy(true); setNotice('Preparing your analysis…')
    try {
      const response = await apiFetch(`${API}/api/files/${fileId}`)
      const result = await response.json(); if (!response.ok) throw new Error(result.detail)
      const created = { id: crypto.randomUUID(), title: `Analyze ${result.filename}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), file_ids: [fileId], active_file_id: fileId, messages: [{ id: crypto.randomUUID(), role: 'assistant', content: result.kind === 'spreadsheet' ? `I’ve loaded **${result.filename}** with ${result.row_count.toLocaleString()} rows and ${result.columns.length} columns. Ask a question, request a chart, or build a dashboard.` : `I’ve opened **${result.filename}**. Ask me to summarize it, explain a section, or answer a question from the document.`, created_at: new Date().toISOString() }] }
      setThreads((current) => [created, ...current]); setActiveId(created.id)
      if (result.kind === 'spreadsheet') { setData(result); setPdf(null) } else { setPdf(result); setData(null) }
      setJoinFileId(spreadsheetFiles.find((file) => file.file_id !== fileId)?.file_id || '')
      setNotice('Your analysis is ready.')
      go('analysis')
    } catch (error) { setNotice(error.message || 'Could not open this file.') }
    finally { setBusy(false) }
  }

  async function openThread(id) {
    const selected = threads.find((item) => item.id === id)
    if (!selected) return
    setActiveId(id); setData(null); setPdf(null); setNotice('')
    const fileId = selected.active_file_id || selected.file_ids?.at(-1)
    if (fileId) {
      setBusy(true)
      try {
        const response = await apiFetch(`${API}/api/files/${fileId}`)
        const result = await response.json(); if (!response.ok) throw new Error(result.detail)
        if (result.kind === 'spreadsheet') setData(result); else setPdf(result)
      } catch (error) { setNotice(error.message || 'The source file could not be reopened.') }
      finally { setBusy(false) }
    }
    go('analysis')
  }

  async function importSheet(event) {
    event.preventDefault(); setBusy(true); setNotice('Adding your Google Sheet…')
    try {
      const response = await apiFetch(`${API}/api/spreadsheets/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sheetUrl }) })
      const result = await response.json(); if (!response.ok) throw new Error(result.detail)
      const { text, rows, ...record } = result
      setFiles((current) => [record, ...current]); setSheetOpen(false); setNotice(`${result.filename} is in My files. Choose Analyze when you’re ready.`)
    } catch (error) { setNotice(error.message || 'Could not import that sheet.') }
    finally { setBusy(false) }
  }

  async function joinFiles(event) {
    event.preventDefault()
    if (!data || !rightFile || !joinLeft || !joinRight || !thread) return
    setBusy(true); setNotice('Combining the two spreadsheets…')
    try {
      const response = await apiFetch(`${API}/api/spreadsheets/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ left_file_id: data.file_id, right_file_id: rightFile.file_id, left_on: joinLeft, right_on: joinRight, join_type: joinType }) })
      const result = await response.json(); if (!response.ok) throw new Error(result.detail)
      const { text, rows, ...record } = result
      setFiles((current) => [record, ...current]); setData(result); attachFileId(thread.id, result.file_id)
      appendMessage(thread.id, { role: 'assistant', content: `I joined **${data.filename}** with **${rightFile.filename}** using a ${joinType} join on “${joinLeft}” and “${joinRight}”. The combined file has ${result.row_count.toLocaleString()} rows. ${result.unmatched_left_rows || result.unmatched_right_rows ? `${(result.unmatched_left_rows || 0).toLocaleString()} rows from the first file and ${(result.unmatched_right_rows || 0).toLocaleString()} rows from the second had no matching key.` : 'Every source row found a matching key.'} Repeated keys can produce multiple matching rows. You can ask questions about the combined data below.` })
      setNotice('Combined file ready. Ask a question about the merged data.')
    } catch (error) { setNotice(error.message || 'Could not join those spreadsheets.') }
    finally { setBusy(false) }
  }

  async function sendQuestion(value = question) {
    const prompt = String(value || '').trim()
    if (!prompt || (!data && !pdf) || !thread) return
    const activeThreadId = thread.id
    appendMessage(activeThreadId, { role: 'user', content: prompt })
    if (thread.messages.length <= 1) updateThread(activeThreadId, (item) => ({ ...item, title: prompt.slice(0, 48) + (prompt.length > 48 ? '…' : '') }))
    setQuestion(''); setBusy(true); setNotice('Thinking through your question…')
    try {
      const url = pdf ? `${API}/api/pdf/ask` : `${API}/api/spreadsheets/ask`
      const payload = pdf ? { task: 'custom', prompt: `${prompt}\n\nUse only the selected document. If the answer is not in it, say so. For factual claims, cite the page marker using [Page N] when the document provides one.\n\n${pdf.text}` } : { question: prompt, file_id: data.file_id }
      const response = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const result = await response.json(); if (!response.ok) throw new Error(result.detail)
      appendMessage(activeThreadId, { role: 'assistant', content: pdf ? result.answer : result.answer, chart: result.chart || null })
      setNotice('Answer added to this analysis.')
    } catch (error) {
      appendMessage(activeThreadId, { role: 'assistant', content: error.message || 'Could not answer that question.' })
      setNotice(error.message || 'Could not answer that question.')
    } finally { setBusy(false) }
  }

  async function createDashboard() {
    if (!data || !thread) return
    setBusy(true); setNotice('Building a dashboard from the full spreadsheet…')
    try {
      const response = await apiFetch(`${API}/api/spreadsheets/dashboard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: data.file_id }) })
      const result = await response.json(); if (!response.ok) throw new Error(result.detail)
      appendMessage(thread.id, { role: 'assistant', content: `Dashboard for **${data.filename}**`, dashboard: result })
      setNotice('Dashboard added to this analysis.')
    } catch (error) { setNotice(error.message || 'Could not build the dashboard.') }
    finally { setBusy(false) }
  }

  function saveThread() {
    if (!thread) return
    const next = [{ id: crypto.randomUUID(), kind: 'conversation', thread_id: thread.id, title: thread.title, filename: activeFiles.map((file) => file.filename).join(' + '), saved_at: new Date().toISOString() }, ...savedWork.filter((item) => item.thread_id !== thread.id)]
    setSavedWork(next)
    try { localStorage.setItem(`fieldnote.saved.${user.email}`, JSON.stringify(next)); setNotice('Analysis saved to Saved work.') }
    catch { setNotice('This browser is out of storage. Download a workspace backup before continuing.') }
  }

  function saveDashboardSnapshot(dashboard, filename) {
    const item = { id: crypto.randomUUID(), kind: 'dashboard', title: dashboard.title, filename, saved_at: new Date().toISOString(), dashboard }
    const next = [item, ...savedWork]; setSavedWork(next)
    try { localStorage.setItem(`fieldnote.saved.${user.email}`, JSON.stringify(next)); setNotice('Dashboard saved to Saved work.') }
    catch { setNotice('This browser is out of storage. Download a workspace backup before continuing.') }
  }

  function downloadWorkspaceBackup() {
    const backup = { format: 'fieldnote-workspace-backup', version: 1, exported_at: new Date().toISOString(), threads, saved_work: savedWork }
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = `fieldnote-backup-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url)
    setNotice('Workspace backup downloaded. It includes conversation history and saved results, not the original files.')
  }

  async function restoreWorkspaceBackup(event) {
    const backupFile = event.target.files?.[0]
    event.target.value = ''
    if (!backupFile) return
    try {
      const backup = JSON.parse(await backupFile.text())
      if (backup.format !== 'fieldnote-workspace-backup' || backup.version !== 1 || !Array.isArray(backup.threads) || !Array.isArray(backup.saved_work)) throw new Error('That file is not a Fieldnote workspace backup.')
      const mergedThreads = [...new Map([...backup.threads, ...threads].filter((item) => item?.id && Array.isArray(item.messages)).map((item) => [item.id, item])).values()].sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
      const mergedSaved = [...new Map([...backup.saved_work, ...savedWork].filter((item) => item?.id).map((item) => [item.id, item])).values()].sort((a, b) => new Date(b.saved_at || 0) - new Date(a.saved_at || 0))
      localStorage.setItem(`fieldnote.threads.${user.email}`, JSON.stringify(mergedThreads))
      localStorage.setItem(`fieldnote.saved.${user.email}`, JSON.stringify(mergedSaved))
      setThreads(mergedThreads); setSavedWork(mergedSaved)
      setNotice(`Restored ${backup.threads.length} conversations and ${backup.saved_work.length} saved items. Original files must be added separately.`)
    } catch (error) { setNotice(error instanceof SyntaxError ? 'That backup file could not be read.' : error.message || 'Could not restore that backup.') }
  }

  function openSavedItem(item) {
    if (item.thread_id) { openThread(item.thread_id); return }
    if (item.dashboard) {
      const archived = { id: crypto.randomUUID(), title: item.title, created_at: item.saved_at, updated_at: item.saved_at, file_ids: [], messages: [{ id: crypto.randomUUID(), role: 'assistant', content: `Saved dashboard from **${item.filename}**.`, dashboard: item.dashboard, created_at: item.saved_at }] }
      setThreads((current) => [archived, ...current]); setActiveId(archived.id); setData(null); setPdf(null); go('analysis')
    }
  }

  async function deleteWorkspaceFile(file) {
    if (!window.confirm(`Delete “${file.filename}” from My files on this device?`)) return
    try {
      const response = await apiFetch(`${API}/api/files/${file.file_id}`, { method: 'DELETE' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not delete this file.')
      setFiles((current) => current.filter((item) => item.file_id !== file.file_id))
      setNotice(`${file.filename} deleted from My files.`)
    } catch (error) { setNotice(error.message || 'Could not delete this file.') }
  }

  function removeSavedItem(item) {
    if (!window.confirm(`Remove “${item.title}” from Saved work?`)) return
    const next = savedWork.filter((saved) => saved.id !== item.id)
    setSavedWork(next)
    try { localStorage.setItem(`fieldnote.saved.${user.email}`, JSON.stringify(next)); setNotice('Removed from Saved work.') }
    catch { setNotice('Could not update Saved work because this browser is out of storage.') }
  }

  function signOut() {
    localStorage.removeItem('fieldnote.session')
    setUser(null)
    setFiles([]); setThreads([]); setSavedWork([]); setActiveId(null)
    setData(null); setPdf(null); setQuestion(''); setNotice('')
    setQualityProfile(null); setQualityError('')
  }

  if (!user) return <AuthScreen onLogin={setUser} />
  const today = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase()
  const pageTitles = { overview: 'Overview', analysis: 'Analysis', files: 'My files', saved: 'Saved work' }
  const backendReady = serviceStatus?.status === 'ok'
  const modelReady = backendReady && serviceStatus?.ollama?.model_ready
  const serviceLabel = !backendReady ? 'Reconnecting' : modelReady ? 'Local AI ready' : serviceStatus?.ollama?.status === 'online' ? 'Model unavailable' : 'Local AI offline'

  return <div className="app-frame">
    <aside className="sidebar">
      <a className="brand" href="#overview"><span className="brand-mark"><span /></span><span>ClarityDesk</span></a>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="Main navigation">
        {['overview', 'analysis', 'files', 'saved'].map((page) => <a key={page} className={`nav-item ${view === page ? 'selected' : 'muted'}`} href={`#${page}`}><span className="nav-icon">{{ overview: '▦', analysis: '◌', files: '▤', saved: '☆' }[page]}</span>{{ overview: 'Overview', analysis: 'Analysis', files: 'My files', saved: 'Saved work' }[page]}</a>)}
      </nav>
      <section className="sidebar-history" aria-label="Recent analyses">
        <div className="sidebar-history-heading"><span>RECENT ANALYSES</span><button onClick={() => { setActiveId(null); setData(null); setPdf(null); go('analysis') }} aria-label="Start a new analysis">＋</button></div>
        {threads.slice(0, 6).map((item) => <button key={item.id} className={`sidebar-thread ${activeId === item.id ? 'current' : ''}`} onClick={() => openThread(item.id)} title={item.title}><span>◌</span><span>{item.title}</span></button>)}
        {!threads.length && <p className="sidebar-history-empty">Your conversations will appear here.</p>}
      </section>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="note-icon">✳</span><div><strong>A little more clarity.</strong><span>Your data workspace, at your pace.</span></div></div><div className="profile"><div className="avatar">{user.name?.slice(0, 1).toUpperCase() || 'Y'}</div><div><strong>{user.name || 'Your workspace'}</strong><span>{user.email}</span></div><button className="signout" onClick={signOut}>Sign out</button></div></div>
    </aside>
    <main className="main-area"><header className="topbar"><div className="breadcrumb">Workspace <span>/</span> {pageTitles[view]}</div><div className="top-actions"><span className={`service-status ${modelReady ? 'online' : ''} ${!backendReady ? 'offline' : ''}`} title={modelReady ? 'PDF questions and local model requests are ready.' : serviceStatus?.ollama?.status === 'online' ? 'Start the llama3.2 model to enable PDF questions.' : 'Uploads and spreadsheet summaries can still work; start Ollama for PDF questions.'}><i />{serviceLabel}</span><button className="help-button" aria-label="Help">?</button></div></header>
      <div className={`page-content ${view === 'analysis' ? 'wide-content' : ''}`}>
        {notice && <div className="notice" role="status">{busy && <span className="spinner" />}{notice}</div>}
        {view === 'overview' && <section className="welcome-row overview-home"><div><p className="eyebrow">{today}</p><h1>Good evening{user.name ? `, ${user.name.split(' ')[0]}` : ''}.</h1><p className="intro">Your files, questions, and findings have a place to come back to.</p><div className="home-actions"><a className="home-primary" href="#files">Add a file <span>＋</span></a><a className="home-secondary" href="#analysis">Open an analysis <span>→</span></a></div></div><div className="date-mark"><span>YOUR SPACE</span><strong>{String(files.length).padStart(2, '0')}</strong><i /></div></section>}
        {view === 'overview' && <section className="home-lower"><div className="home-section-title"><div><span className="section-kicker">YOUR WORKSPACE</span><h2>Pick up where you left off</h2></div><a href="#analysis">All analyses →</a></div>{threads.length ? <div className="file-list">{threads.slice(0, 4).map((item) => <article className="file-item" key={item.id}><span className="file-icon sheet-icon">◌</span><div className="file-info"><strong>{item.title}</strong><span>{item.messages.length} messages · Updated {new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(item.updated_at))}</span></div><button onClick={() => openThread(item.id)}>Continue <span>→</span></button></article>)}</div> : <div className="recent-empty"><div className="empty-doodle">◌</div><div><strong>Your analyses will appear here</strong><p>Choose a file, ask a question, and your conversation will stay available in Analysis.</p></div></div>}</section>}

        {view === 'files' && <section className="library-page"><div className="library-title"><div><span className="section-kicker">YOUR WORKSPACE</span><h1>My files</h1><p>Keep source material here. Open an analysis when you’re ready to ask questions.</p></div><button className="build-dashboard" onClick={() => mixedPicker.current?.click()} disabled={busy}>＋ Add files</button><input ref={mixedPicker} type="file" multiple accept=".pdf,application/pdf,.docx,.pptx,.csv,.tsv,.xlsx,.xlsm,.xls,.ods" hidden onChange={(e) => { uploadFiles(e.target.files); e.target.value = '' }} /></div>
          <div className="library-add-row"><button onClick={() => setSheetOpen(true)} disabled={busy}>＋ Add a Google Sheet</button><span>CSV, TSV, Excel, OpenDocument, PDF, Word (.docx), PowerPoint (.pptx), or a public Google Sheets link.</span></div>
          {files.length ? <div className="file-list">{files.map((file) => <article className="file-item" key={file.file_id}><span className={`file-icon ${file.kind === 'pdf' ? 'pdf-icon' : file.kind === 'document' ? 'sheet-icon' : file.filename?.toLowerCase().includes('google') ? 'sheet-icon' : 'csv-icon'}`}>{file.kind === 'pdf' ? '≡' : file.kind === 'document' ? (file.extension === 'pptx' ? 'P' : 'W') : '▥'}</span><div className="file-info"><strong>{file.filename}</strong><span>{file.kind === 'pdf' ? `PDF · ${file.pages} ${file.pages === 1 ? 'page' : 'pages'}` : file.kind === 'document' ? `${file.document_type} · ${file.count} ${file.count_label}` : `${file.row_count?.toLocaleString()} rows · ${file.columns?.length || 0} columns`}</span></div><button onClick={() => startAnalysis(file.file_id)} disabled={busy}>{file.kind === 'spreadsheet' ? 'Analyze' : 'Ask'} <span>→</span></button><button className="delete-button" onClick={() => deleteWorkspaceFile(file)} aria-label={`Delete ${file.filename}`} title="Delete this file">Delete</button></article>)}</div> : <div className="recent-empty"><div className="empty-doodle">▤</div><div><strong>Your file library is ready</strong><p>Add spreadsheets, PDFs, Word documents, or PowerPoint presentations. Your analyses will be saved separately.</p></div></div>}
        </section>}

        {view === 'analysis' && <section className="analysis-page">
          {!thread ? <div className="analysis-empty"><span className="section-kicker">A WORKSPACE FOR YOUR QUESTIONS</span><h1>What would you like to work through?</h1><p>Choose a file to start a conversation. Your questions, answers, charts, and dashboards stay together here.</p><a className="home-primary" href="#files">Choose from My files <span>→</span></a>
            {threads.length > 0 && <div className="analysis-history"><div className="home-section-title"><h2>Recent analyses</h2></div>{threads.slice(0, 8).map((item) => <button className="thread-row" key={item.id} onClick={() => openThread(item.id)}><span className="thread-icon">◌</span><span><strong>{item.title}</strong><small>{item.messages.length} messages · {new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(item.updated_at))}</small></span><b>→</b></button>)}</div>}
          </div> : <>
            <div className="analysis-head"><div><span className="section-kicker">ANALYSIS</span><h1>{thread.title}</h1><p>{activeFiles.map((file) => file.filename).join(' · ') || data?.filename || pdf?.filename}</p></div><div className="analysis-head-actions"><button className="build-dashboard" onClick={saveThread}>Save work</button><button className="quiet-button" onClick={() => { setActiveId(null); setData(null); setPdf(null); go('analysis') }}>New analysis ＋</button></div></div>
            <div className="analysis-sources">{activeFiles.map((file) => <span className="source-chip" key={file.file_id}>{file.kind === 'spreadsheet' ? 'SHEET' : file.document_type || 'PDF'} · {file.filename}</span>)}{activeFiles.length === 0 && <span className="source-chip">{pdf?.filename || data?.filename || 'Saved dashboard'}</span>}<button onClick={() => mixedPicker.current?.click()} disabled={busy}>＋ Add source</button><input ref={mixedPicker} type="file" multiple accept=".pdf,application/pdf,.docx,.pptx,.csv,.tsv,.xlsx,.xlsm,.xls,.ods" hidden onChange={(e) => { uploadFiles(e.target.files); e.target.value = '' }} /></div>
            {data && spreadsheetFiles.length > 1 && <details className="join-builder"><summary>Bring another spreadsheet into this analysis</summary><p>Choose matching columns with compatible values. Repeated keys can create multiple rows; originals stay in My files. After joining, ClarityDesk reports how many rows had no match.</p><form onSubmit={joinFiles}>
              <label>Match this file’s column<select value={joinLeft} onChange={(e) => setJoinLeft(e.target.value)} required><option value="">Choose a column</option>{data.columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label>
              <label>With spreadsheet<select value={joinFileId} onChange={(e) => { setJoinFileId(e.target.value); setJoinRight('') }} required><option value="">Choose a file</option>{otherJoinFiles.map((file) => <option value={file.file_id} key={file.file_id}>{file.filename}</option>)}</select></label>
              <label>Match its column<select value={joinRight} onChange={(e) => setJoinRight(e.target.value)} required><option value="">Choose a column</option>{rightFile?.columns?.map((column) => <option key={column} value={column}>{column}</option>)}</select></label>
              <label>Keep rows<select value={joinType} onChange={(e) => setJoinType(e.target.value)}><option value="inner">With a match in both files</option><option value="left">All rows from this file</option><option value="outer">All rows from both files</option></select></label>
              <button className="build-dashboard" disabled={busy || !joinLeft || !joinRight}>{busy ? 'Joining…' : 'Join and continue →'}</button>
            </form></details>}
            {data && <div className="analysis-file-preview"><div><span className="section-kicker">SOURCE TABLE</span><strong>{data.filename}</strong><span>{data.row_count.toLocaleString()} rows · {data.columns.length} columns</span></div><details><summary>Preview rows</summary><div className="table-wrap"><table><thead><tr>{data.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{data.rows.slice(0, 8).map((row, index) => <tr key={index}>{data.columns.map((column) => <td key={column}>{String(row[column] ?? '—')}</td>)}</tr>)}</tbody></table></div></details></div>}
            {data && <DataQualityPanel profile={qualityProfile} loading={qualityLoading} error={qualityError} />}
            {data && <button className="build-dashboard dashboard-ask" onClick={createDashboard} disabled={busy}>{busy ? 'Building…' : 'Create a dashboard'} <span>↗</span></button>}
            <div className="chat-transcript">{thread.messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}><div className="message-avatar">{message.role === 'user' ? user.name?.slice(0, 1).toUpperCase() || 'Y' : 'c'}</div><div className="message-body"><span className="message-author">{message.role === 'user' ? user.name || 'You' : 'ClarityDesk'}</span><p>{message.content}</p>{message.chart && <Chart chart={message.chart} />}{message.dashboard && <Dashboard dashboard={message.dashboard} onSave={() => saveDashboardSnapshot(message.dashboard, data?.filename || thread.title)} />}</div></article>)}</div>
            <form className="chat-composer" onSubmit={(e) => { e.preventDefault(); sendQuestion() }}><textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={pdf ? 'Ask about this document…' : 'Ask a question about your data…'} rows={2} disabled={busy || (!data && !pdf)} /><div className="composer-foot"><span>{pdf ? 'Answers use the selected document.' : 'Ask for a comparison, explanation, summary, or chart.'}</span><button className="composer-send" disabled={busy || !question.trim() || (!data && !pdf)}>{busy ? 'Working…' : 'Send ↑'}</button></div></form>
          </>}
        </section>}

        {view === 'saved' && <section className="library-page"><div className="library-title"><div><span className="section-kicker">YOUR WORKSPACE</span><h1>Saved work</h1><p>Conversations and dashboards you’ve chosen to keep close.</p></div><div className="backup-actions"><button className="quiet-button" onClick={downloadWorkspaceBackup}>Download backup</button><button className="build-dashboard" onClick={() => backupPicker.current?.click()}>Restore backup</button><input ref={backupPicker} type="file" accept="application/json,.json" hidden onChange={restoreWorkspaceBackup} /></div></div>
          <p className="backup-note">Backups include conversation history and saved results. Original files stay in My files on this device.</p>
          {savedWork.length ? <div className="file-list">{savedWork.map((item) => <article className="file-item" key={item.id}><span className="file-icon sheet-icon">{item.kind === 'conversation' ? '◌' : '▦'}</span><div className="file-info"><strong>{item.title}</strong><span>{item.filename} · Saved {new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(item.saved_at))}</span></div><button onClick={() => openSavedItem(item)}>Open <span>→</span></button><button className="delete-button" onClick={() => removeSavedItem(item)} aria-label={`Remove ${item.title} from Saved work`} title="Remove from Saved work">Delete</button></article>)}</div> : <div className="recent-empty"><div className="empty-doodle">☆</div><div><strong>No saved work yet</strong><p>Open an analysis and choose Save work, or save an individual dashboard.</p></div></div>}
        </section>}
        <footer className="page-footer"><span>CLARITYDESK</span><span>Make room for the useful details.</span><span className="footer-status">Private by design</span></footer>
      </div>
    </main>
    {sheetOpen && <div className="modal-backdrop" onClick={() => setSheetOpen(false)}><section className="sheet-modal" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={(e) => e.stopPropagation()}><button className="modal-close" aria-label="Close" onClick={() => setSheetOpen(false)}>×</button><span className="file-icon sheet-icon">▦</span><span className="section-kicker">GOOGLE SHEETS</span><h2 id="sheet-title">Bring in a sheet</h2><p>Paste a link to a Google Sheet with access set to “Anyone with the link.” The imported spreadsheet will appear in My files.</p><form onSubmit={importSheet}><label htmlFor="sheet-url">Sheet link</label><input id="sheet-url" type="url" placeholder="https://docs.google.com/spreadsheets/d/…" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} required /><button className="primary-button" disabled={busy}>Add to My files <span>→</span></button></form><span className="modal-footnote">Private sheets and Google sign-in are not connected in this local version.</span></section></div>}
  </div>
}

createRoot(document.getElementById('root')).render(<AppV2 />)
