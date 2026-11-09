/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, Pill, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'

export function ExecutionStatus({ filter: current, state, reload }: {
  filter: TicketFilter; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit } }), [current, limit])
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: value === 'open' ? {} : { filter: value } },
          true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
    </div>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
export function ExecutionSettings() {
  const { t } = usePanel()
  const { blocks, environment, sources } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), blockedCommands: executor.blockedCommands.join(' ') }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
          <Field label={t('executorKind')} hint={t('executorKindHint')}>
            <select className="dt-input" value={value.kind} onChange={event => edit({ kind: event.target.value as typeof value.kind })}>
              {(['harness', 'claude', 'codex', 'cmd'] as const).map(kind => <option key={kind} value={kind}>{kind}</option>)}
            </select>
          </Field>
          <Field label={t('workerPermission')} hint={t('workerPermissionHint')}>
            <select className="dt-input" value={value.permission}
              onChange={event => edit({ permission: event.target.value as typeof value.permission })}>
              <option value="workspace-write">workspace-write</option>
              <option value="danger-full-access">danger-full-access</option>
            </select>
          </Field>
          <Field label={t('routerPermission')} hint={t('routerPermissionHint')}>
            <select className="dt-input" value={value.routerPermission}
              onChange={event => edit({ routerPermission: event.target.value as typeof value.routerPermission })}>
              <option value="read-only">read-only</option>
              <option value="workspace-write">workspace-write</option>
              <option value="danger-full-access">danger-full-access</option>
            </select>
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false} pattern="/.*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <WorkflowSettings />
    <GuardrailsSettings />
    <ProjectsSettings />
    <ConfigHistory blocks={['executor', 'workflow', 'guardrails', 'projects', 'pause']} />
  </div>
}

/** Workflow settings: reviewer model, review/CI round cap, and the watchdog timeout. */
function WorkflowSettings() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const saved = blocks.workflow.value
  const draft = useBlockDraft('workflow', { ...saved, maxRounds: String(saved.maxRounds), timeoutMinutes: String(saved.timeoutMinutes) },
    blocks.workflow.revision, value => ({ ...value, maxRounds: numberOf(value.maxRounds), timeoutMinutes: numberOf(value.timeoutMinutes) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-form dt-block">
        <h2 className="dt-block-title">{t('workflow')}<InfoTip text={t('workflowHint')} /></h2>
        <div className="dt-switch-row"><div className="dt-field-head">{t('workflowEnabled')}<InfoTip text={t('workflowEnabledHint')} /></div>
          <Switch checked={value.enabled} onChange={enabled => edit({ enabled })} label={t('workflowEnabled')} /></div>
        <Field label={t('workflowReviewerModel')} hint={t('workflowReviewerModelHint')}><ModelField id="dt-reviewer-model"
          value={value.reviewerModel} onChange={reviewerModel => edit({ reviewerModel })} /></Field>
        <Field label={t('workflowMaxRounds')} hint={t('workflowMaxRoundsHint')}>
          <Input type="number" min={1} max={10} required value={value.maxRounds} onChange={event => edit({ maxRounds: event.target.value })} />
        </Field>
        <div className="dt-switch-row"><div className="dt-field-head">{t('workflowWatchdog')}<InfoTip text={t('workflowWatchdogHint')} /></div>
          <Switch checked={value.watchdog} onChange={watchdog => edit({ watchdog })} label={t('workflowWatchdog')} /></div>
        <Field label={t('workflowTimeout')} hint={t('workflowTimeoutHint')}>
          <Input type="number" min={5} max={1440} required value={value.timeoutMinutes}
            onChange={event => edit({ timeoutMinutes: event.target.value })} />
        </Field>
      </div>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

/** Alerts and token budgets: proactive messages into the Ticket's conversation, and daily/Ticket spending limits. */
function GuardrailsSettings() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const saved = blocks.guardrails.value
  const draft = useBlockDraft('guardrails', { ...saved, budget: { ...saved.budget, dailyTokens: String(saved.budget.dailyTokens),
    ticketTokens: String(saved.budget.ticketTokens) } }, blocks.guardrails.revision,
    value => ({ ...value, budget: { ...value.budget, dailyTokens: numberOf(value.budget.dailyTokens),
      ticketTokens: numberOf(value.budget.ticketTokens) } }))
  const value = draft.value
  const alerts = (next: Partial<typeof value.alerts>) => draft.edit({ ...value, alerts: { ...value.alerts, ...next } })
  const budget = (next: Partial<typeof value.budget>) => draft.edit({ ...value, budget: { ...value.budget, ...next } })
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-form dt-block">
        <h2 className="dt-block-title">{t('guardrails')}<InfoTip text={t('guardrailsHint')} /></h2>
        <div className="dt-switch-row"><div className="dt-field-head">{t('alertsEnabled')}<InfoTip text={t('alertsEnabledHint')} /></div>
          <Switch checked={value.alerts.enabled} onChange={enabled => alerts({ enabled })} label={t('alertsEnabled')} /></div>
        <div className="dt-switch-row"><div className="dt-field-head">{t('alertsFailures')}<InfoTip text={t('alertsFailuresHint')} /></div>
          <Switch checked={value.alerts.failures} onChange={failures => alerts({ failures })} label={t('alertsFailures')} /></div>
        <div className="dt-switch-row"><div className="dt-field-head">{t('alertsAttention')}<InfoTip text={t('alertsAttentionHint')} /></div>
          <Switch checked={value.alerts.attention} onChange={attention => alerts({ attention })} label={t('alertsAttention')} /></div>
        <div className="dt-switch-row"><div className="dt-field-head">{t('alertsBudget')}<InfoTip text={t('alertsBudgetHint')} /></div>
          <Switch checked={value.alerts.budget} onChange={alertsBudget => alerts({ budget: alertsBudget })} label={t('alertsBudget')} /></div>
        <Field label={t('budgetDailyTokens')} hint={t('budgetDailyTokensHint')}>
          <Input type="number" min={0} max={2_000_000_000} required value={value.budget.dailyTokens}
            onChange={event => budget({ dailyTokens: event.target.value })} />
        </Field>
        <Field label={t('budgetTicketTokens')} hint={t('budgetTicketTokensHint')}>
          <Input type="number" min={0} max={2_000_000_000} required value={value.budget.ticketTokens}
            onChange={event => budget({ ticketTokens: event.target.value })} />
        </Field>
      </div>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

/** Project list editor: each project's repository, worktree root, prepare command, worker model and assessment rules. */
function ProjectsSettings() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const draft = useBlockDraft('projects', blocks.projects.value, blocks.projects.revision)
  const value = draft.value
  const rules = blocks.policy.value.rules
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const update = (index: number, patch: Partial<(typeof value.projects)[number]>) => edit({
    projects: value.projects.map((project, at) => at === index ? { ...project, ...patch } : project) })
  const add = () => {
    let number = value.projects.length + 1
    while (value.projects.some(project => project.id === `project-${number}`)) number += 1
    const id = `project-${number}`
    edit({ projects: [...value.projects, { id, name: '', repository: '', directory: '', prepare: '', model: null, rules: null, enabled: true }],
      activeProject: value.activeProject ?? id })
  }
  const remove = (index: number) => {
    const removed = value.projects[index]!
    const projects = value.projects.filter((_, at) => at !== index)
    edit({ projects, activeProject: value.activeProject === removed.id ? projects.find(project => project.enabled)?.id ?? projects[0]?.id ?? null
      : value.activeProject })
  }
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-form dt-block">
        <h2 className="dt-block-title">{t('projects')}<InfoTip text={t('projectsHint')} /></h2>
        <Field label={t('activeProject')} hint={t('activeProjectHint')}>
          <select className="dt-input" value={value.activeProject ?? ''} onChange={event => edit({ activeProject: event.target.value || null })}>
            {value.projects.map(project => <option key={project.id} value={project.id} disabled={!project.enabled}>{project.name || project.id}</option>)}
          </select>
        </Field>
        {!value.projects.length && <Hint>{t('projectsEmpty')}</Hint>}
        {value.projects.map((project, index) => <div key={project.id} className="dt-form dt-block">
          <h3 className="dt-block-title">{project.name || project.id}
            <button type="button" className="dt-textlink" onClick={() => edit({ activeProject: project.id })} disabled={!project.enabled}
              aria-pressed={value.activeProject === project.id}>{t('projectActive')}</button>
            <Button variant="outline" onClick={() => remove(index)}>{t('projectRemove')}</Button>
          </h3>
          <div className="dt-grid3">
            <Field label={t('projectName')}><Input value={project.name} onChange={event => update(index, { name: event.target.value })} /></Field>
            <Field label={t('projectId')} hint={t('projectIdHint')}><Input className="dt-mono" value={project.id} spellCheck={false}
              pattern="[a-z][a-z0-9-]{0,31}" onChange={event => {
                const id = event.target.value
                edit({ projects: value.projects.map((item, at) => at === index ? { ...item, id } : item),
                  activeProject: value.activeProject === project.id ? id : value.activeProject })
              }} /></Field>
            <Field label={t('projectRepository')} hint={t('projectRepositoryHint')}><Input className="dt-mono" value={project.repository}
              placeholder="owner/name" spellCheck={false} onChange={event => update(index, { repository: event.target.value })} /></Field>
          </div>
          <Field label={t('projectDirectory')} hint={t('projectDirectoryHint')}><Input className="dt-mono" value={project.directory}
            placeholder={t('executionDirectoryEmpty')} spellCheck={false} onChange={event => update(index, { directory: event.target.value })} /></Field>
          <Field label={t('projectPrepare')} hint={t('projectPrepareHint')}><textarea className="dt-textarea dt-mono" rows={3}
            value={project.prepare} spellCheck={false} onChange={event => update(index, { prepare: event.target.value })} /></Field>
          <Field label={t('projectModel')} hint={t('projectModelHint')}><ModelField id={`dt-project-model-${project.id || index}`}
            value={project.model} onChange={model => update(index, { model })} /></Field>
          <Field label={t('projectRules')} hint={t('projectRulesHint')}>
            <select multiple className="dt-input" value={project.rules ?? []} onChange={event => update(index,
              { rules: [...event.target.selectedOptions].map(option => option.value) })}>
              {rules.map(rule => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
            </select>
          </Field>
          <div className="dt-switch-row"><div className="dt-field-head">{t('projectEnabled')}</div>
            <Switch checked={project.enabled} onChange={enabled => update(index, { enabled })} label={t('projectEnabled')} /></div>
        </div>)}
        <Button variant="outline" onClick={add}>{t('projectAdd')}</Button>
      </div>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}
