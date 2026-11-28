/* Served separately as /athena-host.js by the host; never bundled into fixtures. */
(() => {
  'use strict';
  window.AthenaHosted = true;
  let app, events, snapshot, connection, inputContract, retryButton, capabilities = [], piCapabilities = [];
  let generation = 0, activeSession = null, loading = null, destroyed = false;
  let streamEpoch = 0, reload = false, cursor = null, modelProfiles = null;
  const buffered = [];
  const workspaceListeners = new Set(), connectionListeners = new Set(), piListeners = new Set();
  const notify = (listeners, value) => { for (const fn of listeners) fn(value); };
  async function json(url, options) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120000) });
    const body = await response.json();
    if (!response.ok || typeof body?.error === 'string') {
      const error = new Error(body?.error || 'The workspace service could not complete this request.');
      if (typeof body?.code === 'string') error.code = body.code;
      throw error;
    }
    return body;
  }
  async function rpc(method, args) {
    const body = await json('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
    if (!Object.hasOwn(body, 'result')) throw new Error('The workspace service returned an invalid response.');
    return body.result;
  }
  // M3 model-profile surface. Advertised only when the host reports the
  // 'model_profiles' capability; a legacy host keeps the M2 contract exactly.
  // API keys are passed through as request values only and are never stored,
  // rendered, or logged by this adapter.
  function modelProfilesAdapter() {
    if (!Array.isArray(capabilities) || !capabilities.includes('model_profiles')) return null;
    return Object.freeze({
      capability: 'model_profiles',
      listProviders: (query = '') => rpc('listProviders', [String(query)]),
      getProviderCatalog: (providerId, options = {}) => rpc('getProviderCatalog', [providerId, { query: String(options.query || ''), refresh: options.refresh === true, accountRef: options.accountRef }]),
      saveProviderApiKey: (providerId, key) => rpc('saveProviderApiKey', [providerId, key]),
      importLegacyCredentials: () => rpc('importLegacyCredentials', [true]),
      logoutProvider: providerId => rpc('logoutProvider', [providerId]),
      startProviderOAuth: (providerId, accountRef) => rpc('startProviderOAuth', accountRef == null ? [providerId] : [providerId, accountRef]),
      listChatGPTAccounts: () => rpc('listChatGPTAccounts', []),
      signOutChatGPTAccount: accountRef => rpc('signOutChatGPTAccount', [accountRef]),
      getProviderOAuth: flowId => rpc('getProviderOAuth', [flowId]),
      cancelProviderOAuth: flowId => rpc('cancelProviderOAuth', [flowId]),
      ...(capabilities.includes('native_oauth_browser') ? { openProviderOAuthBrowser: flowId => rpc('openProviderOAuthBrowser', [flowId]),
        openChatGPTUsage: () => rpc('openChatGPTUsage', []) } : {}),
      listModelProfiles: () => rpc('listModelProfiles', []),
      saveModelProfile: input => rpc('saveModelProfile', [input]),
      deleteModelProfile: (id, revision) => rpc('deleteModelProfile', [id, revision]),
      setWorkerModelPreference: input => rpc('setWorkerModelPreference',[input]),
      setAppModelProfile: id => rpc('setAppModelProfile', [id]),
      setProjectModelProfile: (projectId, id) => rpc('setProjectModelProfile', [projectId, id]),
      setConversationModelProfile: (sessionId, id) => rpc('setConversationModelProfile', [sessionId, id]),
      verifyModelProfile: id => rpc('verifyModelProfile', [id]),
      registerCompatibleEndpoint: input => rpc('registerCompatibleEndpoint', [input])
    });
  }
  function extensionsAdapter() {
    if (!Array.isArray(capabilities) || !capabilities.includes('extensions')) return null;
    return Object.freeze({
      capability: 'extensions',
      getExtensions: projectId => rpc('getExtensions', [projectId]),
      installGitHubPlugin: (projectId, revision) => rpc('installGitHubPlugin', [projectId, revision]),
      installPlugin: (projectId, manifest, revision) => rpc('installPlugin', [projectId, manifest, revision]),
      setPluginEnabled: (projectId, id, enabled, revision) => rpc('setPluginEnabled', [projectId, id, enabled, revision]),
      removePlugin: (projectId, id, revision) => rpc('removePlugin', [projectId, id, revision]),
      setSkillEnabled: (projectId, id, enabled, revision) => rpc('setSkillEnabled', [projectId, id, enabled, revision]),
      // The caller clears its password field before sending. No token is added
      // to snapshots, adapter state, DOM output or local storage.
      checkMcpServer: (projectId, pluginId, serverId, revision, options = {}) => rpc('checkMcpServer', [projectId, pluginId, serverId, revision, options]),
      ...(capabilities.includes('research_workflow') ? {
        getResearch: (projectId, sessionId) => rpc('getResearch', [projectId, sessionId]),
        decideKnowledge: (projectId, id, decision) => rpc('decideKnowledge', [projectId, id, decision])
      } : {})
    });
  }
  function unbind() {
    generation++; activeSession = null; piListeners.clear(); app.detachPiSession();
  }
  function transport(sessionId) {
    const bound = ++generation;
    activeSession = sessionId;
    const assertCurrent = () => {
      if (destroyed || bound !== generation || sessionId !== activeSession) throw new Error('The active conversation changed. Your draft is preserved.');
    };
    const request = async command => {
      assertCurrent();
      const result = await rpc('pi', [sessionId, command]);
      assertCurrent();
      return result;
    };
    const canStage = piCapabilities.includes('stage_files');
    return {
      mode: 'host', label: 'Athena host connected', capabilities: piCapabilities,
      inputContract,
      supportsFileReferences: canStage,
      request, send: request,
      subscribe(fn) { piListeners.add(fn); return () => piListeners.delete(fn); },
      ...(canStage ? { async stageFiles(files) {
        assertCurrent();
        const encoded = await Promise.all(files.map(async file => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
          return { name: file.name, mimeType: file.type || 'application/octet-stream', data: btoa(binary) };
        }));
        assertCurrent();
        const result = await rpc('stageFiles', [sessionId, encoded]);
        assertCurrent(); return result;
      } } : {})
    };
  }
  function acceptSnapshot(next, bind = true) {
    if (snapshot && next.revision <= snapshot.revision) return;
    const changed = next.sessionId !== activeSession;
    if (changed) unbind();
    snapshot = next;
    notify(workspaceListeners, next);
    if (bind && changed && next.sessionId) app.attachPiTransport(transport(next.sessionId));
  }
  async function activate(method, args) {
    const result = await rpc(method, args);
    if (!result?.sessionId) throw new Error('The host did not confirm a conversation.');
    unbind();
    if (result.snapshot) acceptSnapshot(result.snapshot, false);
    return { ...result, connection: transport(result.sessionId) };
  }
  const manager = {
    get capabilities() { return capabilities; },
    getSnapshot: () => snapshot,
    subscribe(fn) { workspaceListeners.add(fn); return () => workspaceListeners.delete(fn); },
    async createProject(input) {
      const result = await rpc('createProject', [input]);
      if (result?.snapshot) acceptSnapshot(result.snapshot);
      return result;
    },
    createSession: input => activate('createSession', [input]),
    openSession: id => activate('openSession', [id]),
    getAgentHistory: (conversationId, agentSessionId) => rpc('getAgentHistory', [conversationId, agentSessionId]),
    async retryTask(taskId, request) {
      let result, failure;
      try { result = await rpc('retryTask', [taskId, request]); }
      catch (error) { failure = error; }
      // A receipt describes the accepted attempt, not the current snapshot. Read
      // current state separately so replaying a receipt cannot restore old data.
      if (!failure || failure.code) {
        try { acceptSnapshot(await rpc('getSnapshot', [])); } catch (_) { /* SSE/reconnect will hydrate the current state. */ }
      }
      if (failure) throw failure;
      return { ...result, snapshot };
    },
    cancelTask: taskId => rpc('cancelTask', [taskId]),
    cancelRun: runId => rpc('cancelRun', [runId]),
    async setProjectExecution(id, enabled) {
      const result = await rpc('setProjectExecution', [id, enabled]);
      if (result?.snapshot) acceptSnapshot(result.snapshot);
      return result;
    },
    async setProjectDefaultModel(id, model) {
      const result = await rpc('setProjectDefaultModel', [id, model]);
      if (result?.snapshot) acceptSnapshot(result.snapshot);
      return result;
    }
  };
  const connections = {
    getState: () => connection,
    subscribe(fn) { connectionListeners.add(fn); return () => connectionListeners.delete(fn); },
    verifyConnection: input => rpc('verifyConnection', [input]),
    saveConfig: input => rpc('saveConfig', [input])
  };
  function failure(error) {
    unbind();
    connection = { ...connection, status: 'error', verification: { status: 'failed', message: String(error.message || error) } };
    notify(connectionListeners, connection);
    app.reportHostError(String(error.message || error));
    retryButton.hidden = false;
    const status = document.getElementById('ac-pi-session-status');
    if (status) status.textContent = 'Workspace disconnected. Reconnecting will restore saved history. ' + String(error.message || error);
  }
  const validCursor = value => typeof value?.epoch === 'string' && value.epoch.length > 0 && Number.isSafeInteger(value.sequence) && value.sequence >= 0;
  async function bootstrap() {
    if (destroyed) return;
    if (loading) { reload = true; return loading; }
    const streamBound = streamEpoch;
    loading = (async () => {
      try {
        const data = await json('/api/bootstrap');
        if (destroyed || streamBound !== streamEpoch) return;
        const nextCursor = validCursor(data.cursor) ? data.cursor : null;
        capabilities = data.capabilities; piCapabilities = data.piCapabilities; inputContract = data.inputContract;
        snapshot = { ...data.snapshot, execution: data.snapshot.execution ?? data.execution }; connection = data.connection;
        unbind();
        await app.attachTaskManager(manager);
        if (destroyed || streamBound !== streamEpoch) return;
        app.attachConnectionManager(connections);
        modelProfiles = modelProfilesAdapter();
        if (modelProfiles) app.attachModelProfiles?.(modelProfiles);
        app.attachWebAddressOpener?.(capabilities?.includes('system_web_links') ? address => rpc('openWebAddress', [address]) : null);
        window.AthenaFolderPicker=capabilities.includes('project_folder_picker')?()=>rpc('chooseProjectFolder',[]):null;
        if(capabilities.includes('manuscripts')){
          app.attachResearchService?.({knowledge:{
            listSources:input=>rpc('listLibrarySources',[input]),
            searchAndSave:input=>rpc('searchAndSavePapers',[{...input,sessionId:snapshot.sessionId}]),
            canSearch:project=>snapshot?.projectId===project&&snapshot.projects?.some(p=>p.id===project&&p.researchWorkflow)&&!!snapshot.sessionId
          },documents:{getDocument:req=>rpc('getDocument',[req]),saveDocument:req=>rpc('saveDocument',[req])}});
          app.attachPaperService?.((method,request)=>rpc(method,[request]));
        }
        app.attachExtensions?.(extensionsAdapter());
        if (snapshot.sessionId) app.attachPiTransport(transport(snapshot.sessionId));
        await app.refreshPi();
        if (destroyed || streamBound !== streamEpoch) return;
        if (nextCursor) {
          buffered.length = 0;
          cursor = nextCursor;
          connectEvents(cursor);
        } else {
          for (const data of buffered.splice(0)) receive(data);
          if (!events || events.readyState === 2) connectEvents();
        }
        retryButton.hidden = true;
      } catch (error) { if (!destroyed) failure(error); }
      finally { loading = null; if (reload && !destroyed) { reload = false; bootstrap(); } }
    })();
    return loading;
  }
  function receive(data) {
    switch (data.type) {
      case 'snapshot': acceptSnapshot(data.snapshot); break;
      case 'connection': connection = data.connection; notify(connectionListeners, connection); break;
      case 'pi': if (data.sessionId === activeSession) notify(piListeners, data.event); break;
      default: throw new Error('The host sent an unknown event.');
    }
  }
  function resetStream() {
    events?.close(); cursor = null; streamEpoch++; buffered.length = 0;
    void bootstrap();
  }
  function connectEvents(resume = null) {
    events?.close();
    const query = resume ? '?' + new URLSearchParams({ epoch: resume.epoch, after: String(resume.sequence) }) : '';
    const stream = new EventSource('/api/events' + query);
    events = stream;
    stream.onopen = () => {
      if (destroyed || stream !== events) return;
      if (!resume) { streamEpoch++; buffered.length = 0; void bootstrap(); }
      else if (!retryButton.hidden) { retryButton.hidden = true; void app.refreshPi(); }
    };
    stream.onerror = () => {
      if (destroyed || stream !== events) return;
      if (resume) {
        retryButton.hidden = false;
        app.reportHostError('The event stream was interrupted. Reconnecting…');
      } else {
        streamEpoch++; buffered.length = 0;
        failure(new Error('The event stream was interrupted.'));
      }
    };
    stream.onmessage = message => {
      if (destroyed || stream !== events) return;
      try {
        const data = JSON.parse(message.data);
        if (data.type === 'reset') { if (resume) resetStream(); return; }
        if (!resume) { if (loading) buffered.push(data); else receive(data); return; }
        if (!validCursor(data) || message.lastEventId !== data.epoch + ':' + data.sequence || data.epoch !== cursor.epoch) { resetStream(); return; }
        if (data.sequence <= cursor.sequence) return;
        if (data.sequence !== cursor.sequence + 1) { resetStream(); return; }
        receive(data);
        cursor = { epoch: data.epoch, sequence: data.sequence };
      } catch (error) {
        if (resume) resetStream(); else failure(error);
      }
    };
  }
  function start() {
    if (app || !window.AthenaApp) return;
    app = window.AthenaApp; app.enterHostedMode();
    retryButton = document.createElement('button');
    retryButton.id = 'ac-host-reconnect'; retryButton.type = 'button'; retryButton.className = 'ac-text-button cursor-interaction';
    retryButton.textContent = 'Retry connection'; retryButton.hidden = true;
    retryButton.addEventListener('click', () => window.AthenaHost.reconnect());
    document.querySelector('.ac-composer-caption').appendChild(retryButton);
    app.attachConnectionManager(connections);
    connectEvents();
    window.AthenaHost = Object.freeze({
      reconnect() {
        if (cursor) { connectEvents(cursor); return; }
        if (events.readyState === 1 || events.readyState === 2 && !snapshot) return bootstrap();
        connectEvents();
      },
      destroy() { destroyed = true; events.close(); unbind(); workspaceListeners.clear(); connectionListeners.clear(); }
    });
  }
  window.addEventListener('athena:ready', start, { once: true });
  start();
})();
