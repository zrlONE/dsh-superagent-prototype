#!/usr/bin/env node
/**
 * Standalone dsh-superagent dashboard server.
 *
 * Serves the responsive board in `dashboard/` and proxies `/api/dashboard` to the running
 * dsh-superagent management API. It is independent of the Harness Web UI.
 *
 * Usage:
 *   node scripts/dsh-superagent-dashboard.mjs [--port 3083] [--host 127.0.0.1] [--api http://127.0.0.1:3082]
 *
 * Environment:
 *   DASHBOARD_PORT, DASHBOARD_HOST, DASHBOARD_API, DASHBOARD_TOKEN,
 *   DASHBOARD_PRICES  JSON prices per 1M tokens: {"provider/model":{"input":0.27,"output":1.1,"cacheRead":0.07}}
 *
 * Bind a non-loopback host only with DASHBOARD_TOKEN set; the board then requires that token.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard')
const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const port = Number(option('--port') ?? process.env.DASHBOARD_PORT ?? 3083)
const host = option('--host') ?? process.env.DASHBOARD_HOST ?? '127.0.0.1'
const api = (option('--api') ?? process.env.DASHBOARD_API ?? 'http://127.0.0.1:3082').replace(/\/$/, '')
const token = option('--token') ?? process.env.DASHBOARD_TOKEN ?? ''
const prices = (() => {
  const raw = option('--prices') ?? process.env.DASHBOARD_PRICES ?? '{}'
  try { return JSON.parse(raw) } catch (error) { console.error(`DASHBOARD_PRICES is not valid JSON: ${String(error)}`); process.exit(2) }
})()
const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
if (!loopback && !token) {
  console.error('Refusing to bind a non-loopback host without DASHBOARD_TOKEN; set a token for phone access.')
  process.exit(2)
}
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error(`Invalid port: ${port}`); process.exit(2) }

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' }
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : 0
const same = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}
const priceOf = (provider, model) => prices[`${provider}/${model}`] ?? prices[model] ?? null
const costOf = (totals, price) => {
  if (!price || !totals) return null
  return (num(totals.input) * num(price.input) + num(totals.output) * num(price.output)
    + num(totals.cacheRead) * num(price.cacheRead) + num(totals.cacheWrite) * num(price.cacheWrite)) / 1_000_000
}
/** Add estimated USD costs to the API response when prices are configured; unpriced models contribute nothing. */
function decorate(data) {
  let priced = false
  for (const row of [...(data.usage?.byModel ?? []), ...(data.usage?.todayByModel ?? [])]) {
    const value = costOf(row.totals, priceOf(row.provider, row.model))
    if (value !== null) { row.cost = value; priced = true }
  }
  if (priced) {
    data.usage.cost = data.usage.byModel.reduce((sum, row) => sum + (row.cost ?? 0), 0)
    data.usage.todayCost = data.usage.todayByModel.reduce((sum, row) => sum + (row.cost ?? 0), 0)
  }
  for (const agent of data.agents ?? []) {
    const value = costOf(agent.usage, priceOf(agent.provider, agent.model))
    if (value !== null) agent.cost = value
  }
  for (const ticket of data.tickets ?? []) {
    // Ticket agent rows are their own objects; price them before summing the ticket.
    for (const agent of ticket.agents ?? []) {
      const value = costOf(agent.usage, priceOf(agent.provider, agent.model))
      if (value !== null) agent.cost = value
    }
    const costs = (ticket.agents ?? []).map(agent => agent.cost).filter(value => typeof value === 'number')
    if (costs.length) ticket.cost = costs.reduce((sum, value) => sum + value, 0)
  }
  for (const project of data.projects ?? []) {
    const costs = (data.tickets ?? []).filter(ticket => ticket.project?.id === project.id)
      .map(ticket => ticket.cost).filter(value => typeof value === 'number')
    if (costs.length) project.cost = costs.reduce((sum, value) => sum + value, 0)
  }
  return data
}
function cookieToken(request) {
  const header = request.headers.cookie ?? ''
  const match = /(?:^|;\s*)dsh_dashboard=([^;]+)/.exec(header)
  return match ? decodeURIComponent(match[1]) : undefined
}
function authorized(request, url) {
  if (!token) return true
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  const query = url.searchParams.get('token') ?? undefined
  return [cookieToken(request), bearer, query].some(value => value && same(value, token))
}
const json = (response, status, value, headers = {}) => {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  response.end(body)
}
async function dashboardData() {
  const response = await fetch(`${api}/orchestrator/api/dashboard`, { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`management API returned HTTP ${response.status}`)
  return decorate(await response.json())
}
/** Read a small JSON request body; the board's actions carry only an action name and a ticket id. */
async function requestBody(request) {
  let text = ''
  for await (const chunk of request) {
    text += chunk
    if (text.length > 10_000) throw new Error('Request body is too large')
  }
  return text ? JSON.parse(text) : {}
}
/** Pause/resume processing or retry/stop one Ticket through the management API. */
async function runAction(request) {
  const body = await requestBody(request)
  const action = typeof body?.action === 'string' ? body.action : ''
  const ticketId = typeof body?.ticketId === 'string' ? body.ticketId : undefined
  let path, payload
  if (action === 'pause' || action === 'resume') {
    path = '/orchestrator/api/executor/pause'
    payload = { paused: action === 'pause' }
  } else if (action === 'retry' && ticketId) path = `/orchestrator/api/tickets/${encodeURIComponent(ticketId)}/retry`
  else if (action === 'stop' && ticketId) path = `/orchestrator/api/tickets/${encodeURIComponent(ticketId)}/stop`
  else throw Object.assign(new Error('Unknown action'), { status: 400 })
  const response = await fetch(`${api}${path}`, { method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(30_000) })
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : { ok: response.ok } } catch { data = { ok: response.ok, text: text.slice(0, 500) } }
  return { status: response.status, data }
}
async function staticFile(pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const file = normalize(join(ROOT, name))
  if (!file.startsWith(ROOT)) return undefined
  try {
    const body = await readFile(file)
    return { body, type: MIME[extname(file)] ?? 'application/octet-stream' }
  } catch { return undefined }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`)
  // Do not log the query string: the first visit may carry the access token.
  if (url.pathname !== '/api/dashboard') console.log(`${new Date().toISOString()} ${request.method} ${url.pathname} from ${request.socket.remoteAddress ?? '?'}`)
  if (!['GET', 'HEAD', 'POST'].includes(request.method ?? '')) return json(response, 405, { error: 'GET, HEAD or POST only' })
  if (!authorized(request, url)) return json(response, 401, { error: 'Access token required' })
  // A token in the first URL becomes an HttpOnly cookie, then the browser is redirected to a clean address.
  if (token && url.searchParams.has('token') && same(url.searchParams.get('token'), token)) {
    response.writeHead(302, { location: '/', 'set-cookie': `dsh_dashboard=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` })
    response.end()
    return
  }
  if (request.method === 'POST') {
    if (url.pathname !== '/api/action') return json(response, 404, { error: 'Not found' })
    try {
      const result = await runAction(request)
      return json(response, result.status, result.data)
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 502
      return json(response, status, { error: String(error instanceof Error ? error.message : error) })
    }
  }
  if (url.pathname === '/api/dashboard') {
    try { return json(response, 200, await dashboardData()) }
    catch (error) { return json(response, 502, { error: String(error instanceof Error ? error.message : error) }) }
  }
  if (url.pathname === '/healthz') return json(response, 200, { ok: true, api })
  const file = await staticFile(url.pathname)
  if (!file) return json(response, 404, { error: 'Not found' })
  response.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store' })
  if (request.method === 'HEAD') response.end(); else response.end(file.body)
})

server.listen(port, host, () => {
  const shown = host.includes(':') ? `[${host}]` : host
  console.log(`dsh-superagent dashboard: http://${shown}:${port}/`)
  console.log(`  management API: ${api}`)
  console.log(`  prices: ${Object.keys(prices).length ? `${Object.keys(prices).length} model(s)` : 'not configured (tokens only)'}`)
  if (token) console.log('  access token required; open the URL with ?token=<token> once to set a cookie.')
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => process.exit(0)) })
