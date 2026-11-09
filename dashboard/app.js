const REFRESH_MS = 10_000
const $ = selector => document.querySelector(selector)
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : 0
const tokens = value => {
  const n = num(value)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}
const cost = value => typeof value === 'number' && Number.isFinite(value) ? `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}` : '—'
const ago = iso => {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s 前`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m 前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h 前`
  return `${Math.round(seconds / 86400)}d 前`
}
const stageText = ticket => ticket.state === 'ended' ? '已结束' : ticket.stage === 'working' ? '执行中'
  : ticket.stage === 'idle' ? '空闲' : ticket.action === 'review' ? '待验收' : ticket.action === 'answer' ? '待回答'
    : ticket.action === 'failed' ? '失败' : ticket.action === 'blocked' ? '阻塞' : ticket.action === 'delivery' ? '投递失败' : '待处理'
const stageClass = ticket => ticket.state === 'ended' ? '' : ticket.stage === 'working' ? 'working'
  : ticket.stage === 'person' && ticket.action === 'review' ? 'review'
    : ticket.stage === 'person' && (ticket.action === 'failed' || ticket.action === 'blocked') ? 'failed' : ''
const workflowText = workflow => !workflow ? '' : workflow.status === 'reviewing' ? `审阅中 ${workflow.reviewRound}`
  : workflow.status === 'approved' ? `已批准 ${workflow.reviewRound}` : workflow.status === 'changes' ? `待修改 ${workflow.reviewRound}`
    : workflow.status === 'failed' ? '审阅/CI 超限' : ''
const workflowClass = workflow => !workflow ? '' : workflow.status === 'approved' ? 'approved'
  : workflow.status === 'reviewing' || workflow.status === 'changes' ? 'review' : workflow.status === 'failed' ? 'failed' : ''
const agentDot = agent => `<span class="dot ${agent.status === 'running' ? 'running' : agent.status === 'idle' ? 'idle' : ''}" title="${esc(agent.status ?? 'not loaded')}"></span>`
const tokensOf = usage => num(usage?.input) + num(usage?.output) + num(usage?.cacheRead) + num(usage?.cacheWrite)

function summary(data) {
  const open = data.tickets.filter(ticket => ticket.open)
  const working = open.filter(ticket => ticket.stage === 'working').length
  const review = open.filter(ticket => ticket.stage === 'person' && ticket.action === 'review').length
  const failed = open.filter(ticket => ticket.stage === 'person' && (ticket.action === 'failed' || ticket.action === 'blocked')).length
  const today = tokensOf(data.usage.today), total = tokensOf(data.usage.totals)
  const cards = [
    ['打开工单', open.length, `${data.projects.length} 个项目`],
    ['执行中', working, 'working'],
    ['待验收', review, 'awaiting review'],
    ['失败 / 阻塞', failed, 'needs a person'],
    ['今日 tokens', tokens(today), data.usage.todayCost != null ? `≈ ${cost(data.usage.todayCost)}` : '未配置价格'],
    ['累计 tokens', tokens(total), data.usage.cost != null ? `≈ ${cost(data.usage.cost)}` : `${data.usage.sessions.length} 个 session`],
  ]
  $('#summary').innerHTML = cards.map(([label, value, sub]) => `<div class="card"><div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`).join('')
}

function projects(data) {
  $('#projects').innerHTML = data.projects.length ? data.projects.map(project => `<div class="card project">
    <div class="project-head"><h3>${esc(project.name)}</h3>${project.active ? '<span class="badge active">当前</span>' : project.enabled ? '' : '<span class="badge">停用</span>'}</div>
    <div class="repo">${esc(project.repository || '未设置仓库')}</div>
    <div class="stats"><span>打开 <b>${project.open}</b></span><span>执行 <b>${project.working}</b></span>
      <span>待验收 <b>${project.review}</b></span><span>失败 <b>${project.failed}</b></span>
      <span>tokens <b>${tokens(tokensOf(project.tokens))}</b></span>${project.cost != null ? `<span>≈ <b>${cost(project.cost)}</b></span>` : ''}</div>
  </div>`).join('') : '<div class="empty">还没有项目</div>'
}

let latest = undefined
let busy = false

function ticketCard(ticket) {
  const workflow = ticket.workflow
  const agents = (ticket.agents ?? []).map(agent => `${agent.role === 'reviewer' ? '审' : '写'} ${agentDot(agent)} ${esc(agent.model ?? '')}`).join(' · ')
  const actions = ticket.actions ?? {}
  return `<div class="card ticket">
    <div class="ticket-title"><h3>${ticket.url ? `<a href="${esc(ticket.url)}" target="_blank" rel="noreferrer">${esc(ticket.title)}</a>` : esc(ticket.title)}</h3>
      <span class="badge">${esc(ticket.project?.name ?? '')}</span></div>
    <div class="ticket-meta"><span class="tag ${stageClass(ticket)}">${esc(stageText(ticket))}</span>
      ${workflow ? `<span class="tag ${workflowClass(workflow)}" title="${esc(workflow.summary ?? '')}">${esc(workflowText(workflow))}</span>` : ''}
      ${ticket.model ? `<span class="tag">${esc(ticket.model)}</span>` : ''}</div>
    ${ticket.summary ? `<div class="ticket-summary">${esc(ticket.summary)}</div>` : ''}
    <div class="ticket-foot"><span>${agents || '—'}</span><span>${tokens(tokensOf(ticket.tokens))} tokens${ticket.cost != null ? ` · ≈ ${cost(ticket.cost)}` : ''} · ${ago(ticket.updatedAt)}</span></div>
    ${actions.retry || actions.stop ? `<div class="ticket-actions">
      ${actions.retry ? `<button class="button small" type="button" data-action="retry" data-ticket="${esc(ticket.id)}">重试</button>` : ''}
      ${actions.stop ? `<button class="button small danger" type="button" data-action="stop" data-ticket="${esc(ticket.id)}">停止</button>` : ''}
    </div>` : ''}
  </div>`
}
function tickets(data) {
  $('#tickets').innerHTML = data.tickets.length ? data.tickets.map(ticketCard).join('') : '<div class="empty">没有工单</div>'
}

function agents(data) {
  $('#agents').innerHTML = data.agents.length ? data.agents.map(agent => `<div class="card agent">
    <div class="agent-main"><div>${agentDot(agent)} <b>${esc(agent.role)}</b>${agent.ticketId ? ` · ${esc(agent.ticketId.slice(0, 8))}` : ''}</div>
      <div class="id">${esc(agent.sessionId)} · ${esc(agent.model ?? 'no model yet')} · ${esc(agent.status ?? 'not loaded')}</div></div>
    <div class="muted">${tokens(tokensOf(agent.usage))} tokens${agent.cost != null ? ` · ≈ ${cost(agent.cost)}` : ''}</div>
  </div>`).join('') : '<div class="empty">没有已加载的 Agent</div>'
}

function usage(data) {
  const usage = data.usage
  const days = usage.byDay.slice(-7)
  const max = Math.max(1, ...days.map(day => tokensOf(day.totals)))
  const bars = days.map(day => `<div class="bar" style="height:${Math.max(2, Math.round(tokensOf(day.totals) / max * 70))}px" title="${esc(day.day)} · ${tokens(tokensOf(day.totals))} tokens"></div>`).join('')
  const labels = days.map(day => `<span>${esc(day.day.slice(5))}</span>`).join('')
  const rows = usage.byModel.map(row => `<tr><td>${esc(row.provider)}<br><span class="muted">${esc(row.model)}</span></td>
    <td class="num">${tokens(row.totals.input)}</td><td class="num">${tokens(row.totals.output)}</td>
    <td class="num">${tokens(num(row.totals.cacheRead) + num(row.totals.cacheWrite))}</td><td class="num">${row.totals.calls}</td>
    <td class="num">${row.cost != null ? cost(row.cost) : '—'}</td></tr>`).join('')
  $('#usage').innerHTML = `<div class="card">
    <div class="stats"><span>累计 <b>${tokens(tokensOf(usage.totals))}</b> tokens</span><span>今日 <b>${tokens(tokensOf(usage.today))}</b></span>
      ${usage.cost != null ? `<span>≈ <b>${cost(usage.cost)}</b></span>` : '<span>费用未配置</span>'}</div>
    <div class="bars">${bars || '<div class="empty">暂无用量</div>'}</div><div class="bars-labels">${labels}</div>
    ${rows ? `<table class="table"><thead><tr><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存</th><th class="num">调用</th><th class="num">费用</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted" style="margin-top:12px">还没有 token 用量。</p>'}
  </div>`
}

function health(data) {
  const entries = Object.entries(data.health ?? {})
  const errors = entries.filter(([, entry]) => entry.state === 'error').map(([name]) => name)
  const starting = entries.filter(([, entry]) => entry.state === 'starting').map(([name]) => name)
  const pill = $('#health')
  if (errors.length) { pill.dataset.tone = 'error'; pill.textContent = `异常：${errors.join(', ')}` }
  else if (data.paused) { pill.dataset.tone = 'warn'; pill.textContent = '处理已暂停' }
  else if (starting.length) { pill.dataset.tone = 'warn'; pill.textContent = `启动中：${starting.join(', ')}` }
  else { pill.dataset.tone = 'ok'; pill.textContent = '运行中' }
}

function pauseButton(data) {
  const button = $('#pause')
  button.disabled = !data
  button.textContent = data?.paused ? '恢复' : '暂停'
  button.dataset.paused = data?.paused ? 'true' : 'false'
}
async function act(action, ticketId) {
  if (busy) return
  if (action === 'stop' && !confirm('停止这个工单？正在运行的 assignment 会被中止。')) return
  busy = true
  const error = $('#error')
  try {
    const response = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...ticketId ? { ticketId } : {} }) })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    error.hidden = true
    await load()
  } catch (failure) {
    error.hidden = false
    error.textContent = `操作失败：${failure instanceof Error ? failure.message : String(failure)}`
  } finally { busy = false }
}

async function load() {
  const error = $('#error')
  try {
    const response = await fetch('/api/dashboard', { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    latest = data
    health(data); summary(data); projects(data); tickets(data); agents(data); usage(data); pauseButton(data)
    $('#updated').textContent = `更新于 ${new Date(data.at).toLocaleTimeString()} · ${data.workflow?.enabled ? `workflow 开 · ${data.workflow.maxRounds} 轮` : 'workflow 关'}`
    error.hidden = true
  } catch (failure) {
    error.hidden = false
    error.textContent = `无法读取看板数据：${failure instanceof Error ? failure.message : String(failure)}`
  }
}

$('#refresh').addEventListener('click', () => { void load() })
$('#pause').addEventListener('click', () => { void act(latest?.paused ? 'resume' : 'pause') })
$('#tickets').addEventListener('click', event => {
  const button = event.target.closest('[data-action]')
  if (!button) return
  void act(button.dataset.action, button.dataset.ticket)
})
void load()
setInterval(() => { if (document.visibilityState === 'visible') void load() }, REFRESH_MS)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void load() })
