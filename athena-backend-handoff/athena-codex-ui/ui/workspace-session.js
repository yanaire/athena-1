/* Read-only UI projection. Athena TaskManager owns all real scheduling. */
(() => {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const rows = value => Array.isArray(value) ? value : [];
  const id = value => typeof value === 'string' && value.length ? value : null;
  const model = value => value && (value.id || value.modelId) && value.provider ? { provider: value.provider, modelId: value.modelId || value.id, ...(value.thinkingLevel != null ? { thinkingLevel: value.thinkingLevel } : {}) } : null;
  const empty = () => ({ mode: 'runtime', connected: false, taskManagerConnected: false, projectId: null, sessionId: null, revision: -1, projects: [], sessions: [], run: { id: null, status: 'ready', elapsedMs: 0, startedAt: null, model: null }, configuration: {}, tasks: [], agents: [], attempts: [], processes: [], tools: [], artifacts: [], events: [], approvals: [], error: null });

  function create({ demo, runtime, onError, hosted = false } = {}) {
    if (!demo || !runtime) throw new TypeError('Workspace session needs the demo store and runtime bridge.');
    let host = null, hostUnsubscribe = null, epoch = 0, destroyed = false, development = false, hydration = 0;
    let live = empty(), pi = runtime.getState(), activity = null, observedTools = [], observedEvents = [], appDefault = null, lockedModel = null, selectedSession = null;
    const listeners = new Set(), manualTools = new Map(), runModels = new Map(), retryOperations = new Map();
    const retryStorageKey = 'athena.task-retries.v1';
    const retryIdentity = value => JSON.stringify([value.projectId, value.sessionId, value.runId, value.taskId, value.expectedAttemptId]);
    function retryRequestId(value) {
      // Keep only request identities. An uncertain response can be replayed after a
      // reload without submitting a second attempt or retaining prompts/logs here.
      let journal = [], storage;
      try {
        storage = window.localStorage;
        if (!storage?.getItem || !storage?.setItem) throw new Error('Storage unavailable');
        const raw = storage.getItem(retryStorageKey);
        let saved;
        try { saved = JSON.parse(raw || '[]'); } catch (_) { saved = []; }
        if (Array.isArray(saved)) journal = saved.filter(item => typeof item?.key === 'string' && id(item.requestId));
      } catch (_) { throw new Error('The retry request could not be saved. Reopen the app before trying again.'); }
      const key = retryIdentity(value), recorded = journal.find(item => item.key === key);
      if (recorded) return recorded.requestId;
      const requestId = window.crypto?.randomUUID?.();
      if (!requestId) throw new Error('This workspace cannot create a retry request. Reopen the app and try again.');
      try { storage.setItem(retryStorageKey, JSON.stringify([...journal.slice(-63), { key, requestId }])); }
      catch (_) { throw new Error('The retry request could not be saved. Reopen the app before trying again.'); }
      return requestId;
    }
    const isLive = () => Boolean(hosted || host || pi.connected || selectedSession);
    const available = (capability, method) => Boolean(host && live.revision >= 0 && rows(host.capabilities).includes(capability) && typeof host[method] === 'function');
    function getState() {
      if (!isLive()) return copy({ ...demo.getState(), mode: development ? 'demo' : 'preview', connected: false, taskManagerConnected: false, projectId: 'project-rc', sessionId: null, projects: [], sessions: [], modelScopes: { appDefault, projectDefault: null, conversation: null, runLocked: null } });
      const piSessionId = pi.session?.sessionId || pi.session?.id || null;
      const sessionId = selectedSession?.id || live.sessionId || piSessionId;
      const workspaceBound = !host || live.sessionId === sessionId;
      const projectId = selectedSession?.projectId ?? (workspaceBound ? live.projectId : null);
      const sessionBound = Boolean(pi.connected && sessionId && piSessionId === sessionId);
      const inScope = item => (!item.sessionId || item.sessionId === sessionId) && (!item.projectId || item.projectId === projectId);
      const tools = new Map(live.tools.filter(inScope).map(item => [item.id, { ...item, source: 'task-manager' }]));
      for (const item of [...observedTools, ...manualTools.values()].filter(inScope)) {
        const recorded = tools.get(item.id);
        tools.set(item.id, { ...item, ...recorded, taskId: recorded?.taskId || item.taskId || null, source: recorded ? 'task-manager' : 'pi' });
      }
      const project = live.projects.find(item => item.id === projectId);
      const sessions = [...live.sessions];
      if (selectedSession && !sessions.some(item => item.id === selectedSession.id)) sessions.push(selectedSession);
      return copy({ ...live, sessions, hydration, mode: 'runtime', sessionBound, workspaceBound, connected: Boolean(pi.connected || host && live.revision >= 0), taskManagerConnected: Boolean(host && live.revision >= 0), taskManagerStatus: !host ? 'disconnected' : live.error ? 'error' : live.revision >= 0 ? 'connected' : 'connecting', projectId, sessionId,
        run: host && workspaceBound ? live.run : sessionBound ? { id: pi.session?.runId || null, status: pi.session?.isStreaming ? 'running' : activity?.settled ? activity.phase === 'error' ? 'failed' : activity.phase === 'stopped' ? 'cancelled' : 'succeeded' : 'ready', startedAt: activity?.startedAt || null, elapsedMs: activity?.elapsedMs || 0, model: lockedModel } : empty().run,
        execution: workspaceBound && live.execution && live.execution.projectId === projectId ? { ...live.execution, canEdit: Boolean(projectId) && available('set_project_execution', 'setProjectExecution') } : null,
        tasks: workspaceBound ? live.tasks.filter(inScope) : [], agents: workspaceBound ? live.agents.filter(inScope) : [], attempts: workspaceBound ? live.attempts.filter(inScope) : [], processes: workspaceBound ? live.processes.filter(inScope) : [], artifacts: workspaceBound ? live.artifacts.filter(inScope) : [], approvals: workspaceBound ? live.approvals.filter(inScope) : [], tools: [...tools.values()],
        events: [...live.events.filter(inScope), ...observedEvents.filter(inScope)].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index),
        retryOperations: workspaceBound ? Object.fromEntries([...retryOperations.values()].filter(item => inScope(item) && item.runId === live.run.id && (item.pending || live.tasks.some(task => task.id === item.taskId && task.attemptId === item.expectedAttemptId))).map(({ taskId, expectedAttemptId, requestId, pending, accepted, error }) => [taskId, { expectedAttemptId, requestId, pending, accepted, error }])) : {},
        modelScopes: { appDefault, projectDefault: model(project?.defaultModel), conversation: sessionBound && model(pi.model) ? { ...model(pi.model), thinkingLevel: pi.thinkingLevel } : null, runLocked: host && workspaceBound ? live.run?.model : sessionBound ? lockedModel : null },
        capabilities: { createProject: available('create_project', 'createProject'), createSession: available('create_session', 'createSession'), openSession: available('open_session', 'openSession'), backgroundSessions: available('background_sessions','openSession'), setProjectModel: Boolean(projectId) && available('set_project_model', 'setProjectDefaultModel'), retryTask: workspaceBound && available('retry_task', 'retryTask'), cancelRun: workspaceBound && available('cancel_run', 'cancelRun'), cancelTask: workspaceBound && available('cancel_task', 'cancelTask'), agentHistory: workspaceBound && available('get_agent_history', 'getAgentHistory'), decideApproval: workspaceBound && available('decide_approval', 'decideApproval') }
      });
    }
    function publish() { if (!destroyed) { const state = getState(); for (const fn of listeners) fn(state); } }
    function ingest(input, rehydrate = false) {
      const snapshot = input ? copy(input) : input;
      if (!host || destroyed || !snapshot || !Number.isSafeInteger(snapshot.revision) || (!rehydrate && snapshot.revision <= live.revision)) return false;
      if (!id(snapshot.sessionId) && rows(snapshot.tasks).length) throw new Error('Task snapshots must identify their session.');
      for (const name of ['projects', 'sessions', 'tasks', 'agents', 'attempts', 'processes', 'tools', 'artifacts', 'events', 'approvals']) {
        if (rows(snapshot[name]).some(item => !id(item?.id))) throw new Error(name + ' must retain host-issued identifiers.');
      }
      if (live.sessionId && snapshot.sessionId !== live.sessionId) { activity = null; observedTools = []; manualTools.clear(); observedEvents = []; lockedModel = null; }
      const runKey = snapshot.sessionId + '\u241f' + (snapshot.run?.id || '');
      const remembered = snapshot.run?.id && runModels.get(runKey);
      const supplied = model(snapshot.run?.model);
      const runError = remembered && supplied && JSON.stringify(remembered) !== JSON.stringify(supplied) ? 'The host attempted to change the execution-start model for an existing run.' : null;
      if (snapshot.run?.id && supplied && !remembered) runModels.set(runKey, copy(supplied));
      live = { ...empty(), ...snapshot, mode: 'runtime', connected: true, taskManagerConnected: true,
        projects: rows(snapshot.projects), sessions: rows(snapshot.sessions), tasks: rows(snapshot.tasks).map(item => ({ ...item, dependencies: rows(item.dependencies), toolIds: rows(item.toolIds), artifactIds: rows(item.artifactIds) })),
        agents: rows(snapshot.agents), attempts: rows(snapshot.attempts), processes: rows(snapshot.processes), tools: rows(snapshot.tools).map(item => ({ ...item, logs: rows(item.logs), args: item.args || {} })), artifacts: rows(snapshot.artifacts), events: rows(snapshot.events), approvals: rows(snapshot.approvals),
        run: { ...empty().run, ...(snapshot.run || {}), model: remembered || supplied || null }, error: runError };
      if (selectedSession?.id === live.sessionId) selectedSession = null;
      publish(); return true;
    }
    function report(error) { live.error = String(error?.message || error); onError?.(live.error); publish(); }
    async function attach(adapter) {
      if (!adapter || typeof adapter.subscribe !== 'function' || typeof adapter.getSnapshot !== 'function') throw new TypeError('TaskManager needs getSnapshot() and subscribe().');
      if (host === adapter) {
        const bound = epoch, snapshot = await adapter.getSnapshot();
        if (bound === epoch && host === adapter) { hydration++; ingest(snapshot, true); }
        return getState();
      }
      detach(); host = adapter; development = false; demo.cancel(); live = empty(); live.taskManagerConnected = false;
      const bound = epoch;
      hostUnsubscribe = adapter.subscribe(next => { if (bound === epoch && host === adapter) try { ingest(next); } catch (error) { report(error); } });
      publish();
      try { const snapshot = await adapter.getSnapshot(); if (bound === epoch && host === adapter) ingest(snapshot); }
      catch (error) { if (bound === epoch) report(error); throw error; }
      return getState();
    }
    function detach() { epoch++; hostUnsubscribe?.(); hostUnsubscribe = null; host = null; runModels.clear(); retryOperations.clear(); live = empty(); selectedSession = null; activity = null; observedTools = []; manualTools.clear(); observedEvents = []; lockedModel = null; publish(); }
    async function command(capability, method, args) {
      if (!available(capability, method)) throw new Error('The connected TaskManager does not provide ' + capability.replaceAll('_', ' ') + '.');
      const bound = epoch, current = host; const result = await current[method](...args);
      if (destroyed || bound !== epoch || current !== host) throw new Error('The workspace connection changed.');
      if (result?.snapshot) ingest(result.snapshot);
      else if (['createProject', 'createSession', 'openSession', 'setProjectDefaultModel'].includes(method)) {
        try { const snapshot = await current.getSnapshot(); if (!destroyed && bound === epoch && current === host) ingest(snapshot); }
        catch (error) { if (bound === epoch && current === host) report(error); }
        if (destroyed || bound !== epoch || current !== host) throw new Error('The workspace connection changed.');
      }
      return result;
    }
    function retryTask(taskId) {
      if (!isLive()) return demo.retryTask(taskId);
      const current = getState(), task = current.tasks.find(item => item.id === taskId);
      if (!current.capabilities?.retryTask || !task) return Promise.resolve(null);
      const key = JSON.stringify([current.projectId, current.sessionId, current.run.id, taskId]);
      const previous = retryOperations.get(key);
      if (previous?.pending) return previous.promise;
      if (previous?.accepted && previous.expectedAttemptId === task.attemptId) return Promise.resolve(previous.result);
      if (task.retryable !== true || !task.parentTaskId || !id(task.attemptId)) return Promise.resolve(null);
      const operation = { projectId: current.projectId, sessionId: current.sessionId, runId: current.run.id, taskId, expectedAttemptId: task.attemptId, requestId: previous?.expectedAttemptId === task.attemptId ? previous.requestId : null, pending: true, accepted: false, error: null };
      retryOperations.set(key, operation);
      try { operation.requestId ||= retryRequestId(operation); }
      catch (error) { operation.pending = false; operation.error = String(error?.message || error); publish(); return Promise.resolve(null); }
      const bound = epoch, adapter = host;
      // Deferring the call by one microtask lets every view observe the pending
      // operation before a second click can reach the adapter.
      operation.promise = Promise.resolve().then(() => {
        if (destroyed || bound !== epoch || adapter !== host) throw new Error('The workspace connection changed.');
        return command('retry_task', 'retryTask', [taskId, { requestId: operation.requestId, expectedAttemptId: operation.expectedAttemptId }]);
      }).then(result => {
        if (result?.taskId !== taskId || result?.runId !== operation.runId || !id(result?.attemptId) || result.attemptId === operation.expectedAttemptId) throw new Error('The host did not confirm a new attempt for this task.');
        operation.accepted = true; operation.result = result; return result;
      }).catch(error => { operation.error = String(error?.message || error); return null; }).finally(() => {
        operation.pending = false;
        if (!destroyed && bound === epoch && adapter === host) publish();
      });
      publish(); return operation.promise;
    }
    function observationScope() {
      const sessionId = pi.session?.sessionId || pi.session?.id || null;
      return { sessionId, projectId: live.sessionId === sessionId ? live.projectId : selectedSession?.id === sessionId ? selectedSession.projectId : null, runId: live.sessionId === sessionId ? live.run?.id || null : pi.session?.runId || null };
    }
    function observeActivity(next) {
      if (!pi.connected) return;
      activity = next;
      const scope = observationScope();
      observedTools = rows(next.tools).map(tool => ({ ...tool, ...scope, id: tool.toolCallId || tool.id, taskId: tool.taskId || null, name: tool.toolName || tool.name, sdkToolName: tool.toolName || tool.name, command: tool.args?.command || '', cwd: tool.args?.cwd || '', logs: tool.output ? [{ at: tool.endedAt || tool.startedAt || 0, text: tool.output }] : [], exitCode: tool.exitCode ?? null }));
      publish();
    }
    function observeManual(tool) { if (!pi.connected) return; const key = tool.toolCallId || tool.id; manualTools.set(key, { ...tool, ...observationScope(), id: key, taskId: null, name: 'bash', sdkToolName: 'bash', command: tool.args?.command || '', logs: [{ at: tool.endedAt || tool.startedAt, text: tool.output || '' }], source: 'pi' }); publish(); }
    const runtimeOff = runtime.subscribe(next => {
      const previous = pi.session?.sessionId || pi.session?.id, current = next.session?.sessionId || next.session?.id;
      if (next.connected && !pi.connected) { development = false; demo.cancel(); }
      if (!next.connected || previous && current && previous !== current) { activity = null; observedTools = []; manualTools.clear(); observedEvents = []; lockedModel = null; }
      if (!host && selectedSession?.id === previous && current && current !== previous) selectedSession = null;
      pi = next; publish();
    });
    const eventOff = runtime.subscribeEvents(event => {
      if (event.type === 'agent_start') { lockedModel = model(pi.model); if (lockedModel) lockedModel.thinkingLevel = pi.thinkingLevel; publish(); }
      if (event.type === 'session_changed' || event.type === 'host_session_changed') { activity = null; observedTools = []; manualTools.clear(); observedEvents = []; lockedModel = null; publish(); }
      if (['tool_execution_start', 'tool_execution_end', 'host_command_start', 'host_command_end'].includes(event.type)) {
        const toolId = event.toolCallId || event.id;
        if (toolId) { const entry = { ...observationScope(), id: 'pi:' + (pi.session?.sessionId || pi.session?.id || '') + ':' + toolId + ':' + event.type, toolId, taskId: event.taskId || null, type: 'tool.' + (event.type.endsWith('start') ? 'started' : 'finished'), at: event.at || Date.now(), summary: (event.toolName || event.command || 'Tool') + (event.type.endsWith('start') ? ' started' : ' finished') }; observedEvents = [...observedEvents.filter(item => item.id !== entry.id), entry]; publish(); }
      }
    });
    const demoOff = demo.subscribe(() => { if (!isLive()) publish(); });
    const local = name => (...args) => { if (isLive()) return false; development = true; return demo[name](...args); };
    return {
      getState, subscribe(fn) { listeners.add(fn); fn(getState()); return () => listeners.delete(fn); }, attach, detach, ingest, observeActivity, observeManual,
      confirmSession(value) {
        const sessionId = id(value?.sessionId);
        if (!sessionId) throw new Error('Session activation needs a host-confirmed identifier.');
        selectedSession = { id: sessionId, projectId: id(value.projectId) || (live.sessionId === sessionId ? live.projectId : null), title: String(value.title || sessionId), model: model(value.model) };
        activity = null; observedTools = []; manualTools.clear(); observedEvents = []; lockedModel = null;
        if (host && live.sessionId === sessionId) selectedSession = null;
        publish(); return getState();
      },
      setAppDefault(value) { appDefault = model(value); publish(); },
      enterHostedMode() { hosted = true; development = false; demo.cancel(); publish(); },
      setDevelopment(enabled) { if (isLive()) return false; development = Boolean(enabled); if (!development) demo.cancel(); publish(); return true; },
      createProject: input => command('create_project', 'createProject', [input]), createSession: input => command('create_session', 'createSession', [input]), openSession: sessionId => command('open_session', 'openSession', [sessionId]),
      setProjectDefaultModel: value => command('set_project_model', 'setProjectDefaultModel', [getState().projectId, value]),
      setProjectExecution: (projectId, enabled) => command('set_project_execution', 'setProjectExecution', [projectId, enabled]),
      async getAgentHistory(conversationId, agentSessionId) {
        const current = getState();
        if (!current.capabilities?.agentHistory || current.sessionId !== conversationId || !current.agents.some(agent => agent.agentSessionId === agentSessionId)) throw new Error('Agent history is not available in this conversation.');
        const result = await command('get_agent_history', 'getAgentHistory', [conversationId, agentSessionId]);
        if (getState().sessionId !== conversationId) throw new Error('The active conversation changed.');
        if (!Array.isArray(result?.messages) || result.agentSessionId !== agentSessionId || (result.conversationId ?? result.sessionId) !== conversationId) throw new Error('The host returned history for a different agent or conversation.');
        return result.messages;
      },
      retryTask,
      cancelTask: taskId => command('cancel_task', 'cancelTask', [taskId]).catch(report),
      cancel: (runId = live.run.id) => isLive() ? command('cancel_run', 'cancelRun', [runId]).catch(report) : demo.cancel(),
      decideApproval: (approvalId, decision) => isLive() ? command('decide_approval', 'decideApproval', [approvalId, decision]).catch(report) : demo.decideApproval(approvalId, decision),
      start: local('start'), pause: local('pause'), resume: local('resume'), reset: local('reset'), setScenario: local('setScenario'), configure: config => { if (!isLive()) return demo.configure(config); return false; },
      destroy() { if (destroyed) return; hostUnsubscribe?.(); runtimeOff(); eventOff(); demoOff(); listeners.clear(); destroyed = true; epoch++; }
    };
  }
  window.AthenaWorkspaceSession = { create };
})();
