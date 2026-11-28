(()=>{'use strict';
 const root=document.getElementById('athena-codex');if(!root)return;
 const hosted=window.AthenaHosted===true||(/^https?:$/.test(window.location?.protocol||'')&&window.location?.pathname==='/');
 const q=s=>root.querySelector(s),qa=s=>Array.from(root.querySelectorAll(s));
 const controller=new AbortController(),signal=controller.signal;
 const LEFT_VISIBILITY_KEY='athena.ui.project-sidebar-open.v1';
 function savedLeftOpen(){try{return window.localStorage.getItem(LEFT_VISIBILITY_KEY)!=='false'}catch(_){return true}}
 const state={panelOpen:false,panelTab:'results',sideView:'surface',artifact:'response',leftOpen:savedLeftOpen(),leftDrawer:false,documentEditing:false,busy:false,taskState:'needs-confirmation',newAssignments:true,lastSubmission:null};
 let surfaces=null,layout=null,settings=null,workspaceStore=null,workspaceViews=null,workspaceChrome=null,knowledge=null,modelSettings=null,chatModelPicker=null,demoStore=null,connectionManager=null,records=null,recordToolbar=null,workspaceOff=null,connectionOff=null,recordsOff=null;
 let providerProfiles=null,modelProfilesAdapter=null,extensions=null,extensionService=null;
 let piActivity=null,piView=null,piSubscription=null,piSession=null,piSessionUnsubscribe=null,piSessionEpoch=0,piRunId=null,piText='',piEngaged=false,piPreviewActive=false,appDestroyed=false;
 let piHistoryAfterSettle=-1;
 let piRuntime=null,piWorkbench=null,piRuntimeSubscription=null,piEventSubscription=null,piManualView=null,piSessionIdentity='',piCommandSignature='',piWidgetSignature='',piHistorySignature='',piSubmitting=false,piDraftOffer='',piDraftSeen='',piTurnEpoch=0,piSubmittedContext=null;
 const piManualTools=new Map(), sessionDrafts=new Map();
 const failedDrafts=[];
 let paperPanel, researchFlow, shownResearchSession=null,currentResearchStage='';
 let projectSignature='', activeProjectId='project-rc', activeDocumentId='research-note', requestedDocumentVersion=null, lifecyclePending=false, nativeSessionTransition=null;
 const activityHome=q('#aw-activity').parentElement,activityBefore=q('#aw-activity').nextElementSibling;
 const piPreviewTimers=new Set();
 const WORKSPACE_VIEWS=['workflow','artifacts','timeline','knowledge'];
 let opener=null,dialogOpener=null,dialogAction=null,toastTimer=0,reconcileTimer=0;
 const listen=(el,type,fn,options={})=>el.addEventListener(type,fn,{...options,signal});
 // Lucide copies data-lucide onto the SVG. Replacing those finished SVGs on
 // every worker event makes a long conversation unresponsive.
 const pendingIcons={querySelectorAll:selector=>root.querySelectorAll(selector+':not(svg)')};
 const icons=()=>{if(window.lucide)window.lucide.createIcons({root:pendingIcons,attrs:{'aria-hidden':'true'}})};
 // Parent messages and host child snapshots can grow the same transcript in
 // separate callbacks. Capture before the first DOM mutation, not after a
 // child card has already grown. Nested renders share one scroll decision.
 let conversationLayoutDepth=0,conversationLayoutAnchor=null;
 function beforeConversationLayout(){
  if(conversationLayoutDepth===0){
   const scroller=q('.ac-conversation-inner');
   conversationLayoutAnchor=scroller?{scroller,top:scroller.scrollTop,follow:scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<90}:null;
  }
  conversationLayoutDepth++;
 }
 function afterConversationLayout(){
  if(conversationLayoutDepth<=0||--conversationLayoutDepth!==0)return;
  const anchor=conversationLayoutAnchor;conversationLayoutAnchor=null;
  if(appDestroyed||!anchor?.scroller.isConnected)return;
  // A user reading earlier messages keeps that position through history
  // replacement as well. No follow preference leaks into another callback.
  anchor.scroller.scrollTop=anchor.follow?anchor.scroller.scrollHeight:anchor.top;
 }

 const files={
  'baseline.cir':'* Athena UI example — ideal RC low-pass\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.ac dec 100 10 100k\n.end',
  'ac_response.csv':'# Illustrative values for UI design\nfrequency_hz,gain_db\n100,-0.0171\n1000,-1.4451\n1592,-3.0103\n10000,-16.0722',
  'simulation.log':'[Example run v1]\nInput: baseline.cir\nProgram: ngspice\nAnalysis: AC / 10 Hz–100 kHz\nResult: completed\nCheck: theoretical error < 1%\n\nThis file contains design sample data.'
 };
 const note='Frequency response validation of an RC low-pass filter\n\nObjective\nCompare the frequency response and cutoff frequency of an ideal RC circuit with analytical values.\n\nMethod\nA 1 kΩ resistor and 100 nF capacitor were used. The AC response was evaluated from 10 Hz to 100 kHz.\n\nResults\nThe cutoff frequency was 1.592 kHz, with a relative error of approximately 0.03% against the theoretical value of 1.5915 kHz. This is within the 1% tolerance.\n\nScope and limitations\nComponent tolerances, nonideal behavior, and measurement equipment effects were not included.\n\nThis document contains sample content for the UI prototype.';
 q('#ac-document-editor').value=note;
 let displayedNote=note;
 function toast(message){q('#ac-toast').textContent=message;q('#ac-toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>q('#ac-toast').hidden=true,3500)}
 function announce(message){q('#ac-live-status').textContent=message}
 function syncLeftUI(){
  state.leftDrawer=state.leftOpen&&root.clientWidth<=600;
  for(const [key,value] of [['leftOpen',state.leftOpen],['leftDrawer',state.leftDrawer]]){if(root.dataset[key]!==String(value))root.dataset[key]=String(value)}
  q('#ac-sidebar').hidden=!state.leftOpen;
  q('#ac-left-toggle').hidden=state.leftOpen;
  q('#ac-left-toggle').setAttribute('aria-expanded',String(state.leftOpen));
  q('#ac-sidebar-collapse').setAttribute('aria-expanded',String(state.leftOpen));
 }
 function overlay(){
  syncLeftUI();
  const rightOverlay=state.panelOpen&&root.dataset.panelLayout==='overlay',left=state.leftDrawer,settingsOpen=Boolean(settings?.isOpen()),approvalOpen=Boolean(workspaceChrome?.isApprovalOpen()),piDialogOpen=Boolean(piWorkbench?.isDialogOpen()),dialogOpen=!q('#ac-dialog-backdrop').hidden||settingsOpen||approvalOpen||piDialogOpen;
  if(rightOverlay||left||dialogOpen)chatModelPicker?.close(false);
  const scrim=q('#ac-overlay-scrim');scrim.hidden=!(rightOverlay||left);scrim.disabled=left;scrim.tabIndex=-1;scrim.setAttribute('aria-hidden',String(left));
  q('#ac-conversation').inert=rightOverlay||left||dialogOpen;q('.ac-header').inert=left||dialogOpen;q('#ac-sidebar').inert=dialogOpen;q('#ac-research-panel').inert=left||dialogOpen;
  q('#ac-research-panel').removeAttribute('role');q('#ac-research-panel').removeAttribute('aria-modal');
  if(left&&!dialogOpen){q('#ac-sidebar').setAttribute('role','dialog');q('#ac-sidebar').setAttribute('aria-modal','true')}else{q('#ac-sidebar').removeAttribute('role');q('#ac-sidebar').removeAttribute('aria-modal')}
  q('#ac-dialog-backdrop').inert=settingsOpen||approvalOpen||piDialogOpen;
  if(q('#ac-settings-backdrop'))q('#ac-settings-backdrop').inert=approvalOpen||piDialogOpen;
  if(q('.aw-approval-backdrop'))q('.aw-approval-backdrop').inert=piDialogOpen;
  const active=document.activeElement;
  const inaccessible=element=>{if(!element||!element.isConnected||element.closest('[hidden]'))return true;for(let parent=element;parent;parent=parent.parentElement)if(parent.inert)return true;return false};
  if(root.contains(active)&&inaccessible(active)){
   const area=piDialogOpen?q('.apw-dialog-backdrop'):approvalOpen?q('.aw-approval-backdrop'):settingsOpen?q('#ac-settings-backdrop'):dialogOpen?q('.ac-dialog'):left?q('#ac-sidebar'):rightOverlay?q('#ac-research-panel'):q('#ac-conversation');
   const target=Array.from(area?.querySelectorAll('button:not([disabled]),input:not([hidden]),select,textarea,summary,[tabindex="0"]')||[]).find(element=>!inaccessible(element));
   (target||q('#ac-panel-toggle')).focus({preventScroll:true});
  }
 }
 function panelTab(tab){if(!['workflow','results','manuscript'].includes(tab))return;state.panelTab=tab;qa('[data-panel-tab]').forEach(b=>{const active=b.dataset.panelTab===tab;b.classList.toggle('ac-active',active);b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1});qa('.ac-panel-body').forEach(el=>el.hidden=el.id!=='ac-view-'+tab);drawChart()}
 function setArtifact(id){if(!['response','table',...Object.keys(files)].includes(id))return;state.artifact=id;q('#ac-artifact-select').value=id;qa('[data-result-view]').forEach(el=>el.hidden=el.dataset.resultView!==(files[id]?'file':id));if(files[id]){q('#ac-file-title').textContent=id;q('#ac-file-content').textContent=files[id]}drawChart()}
 function showPanel(from){
  composer.closeMenu?.();
  if(from)opener=from;else if(!state.panelOpen)opener=document.activeElement;
  state.panelOpen=true;root.dataset.panelOpen='true';
  q('#ac-research-panel').hidden=false;syncPanelToggle(true);
 }
 function selectSideView(view,title){
  const slots=['research','surface','workbench','knowledge'];
  const focusWillHide=slots.some(slot=>slot!==view&&q('#ac-'+slot+'-slot').contains(document.activeElement));
  state.sideView=view;root.dataset.sideView=view;
  for(const slot of slots)q('#ac-'+slot+'-slot').hidden=view!==slot;
  q('#ac-side-title').textContent=title;
  q('#ac-knowledge-nav').setAttribute('aria-expanded',String(state.panelOpen&&view==='knowledge'));
  qa('.aw-side-nav [data-workspace-view]').forEach(button=>button.setAttribute('aria-pressed',String(view==='knowledge'?button.dataset.workspaceView==='knowledge':view==='workbench'&&button.dataset.workspaceView===state.workspaceView)));
  return focusWillHide;
 }
 function openPanel(tab=state.panelTab,artifact=null,from=null){
  if(tab==='results'&&workspaceStore?.getState().mode==='runtime'){openWorkspace('artifacts',artifact?{artifactId:artifact}:null,from);return;}
  if(tab==='workflow'){openWorkspace('workflow',null,from);return}
  showPanel(from);const moveFocus=selectSideView('research','Research');
  if(artifact)setArtifact(artifact);panelTab(tab);layout?.refresh();overlay();
  announce(({'workflow':'Workflow','results':'Results','manuscript':'Manuscript'}[state.panelTab])+' view opened.');
  if((root.dataset.panelLayout==='overlay'||moveFocus)&&!q('#ac-research-panel').inert)q('#ac-tab-'+state.panelTab).focus({preventScroll:true});
 }
 function openSurface(id='home',from=null){
  if(id==='agents'){openWorkspace('timeline',null,from);return}
  if(id==='terminal'||id==='execution'){openWorkspace('execution',null,from);return}
  if(WORKSPACE_VIEWS.includes(id)){openWorkspace(id,null,from);return}
  showPanel(from);selectSideView('surface','Surfaces');
  layout?.refresh();overlay();surfaces?.open(id,!q('#ac-research-panel').inert);announce('Side view opened.');
 }
 function openWorkspace(view='workflow',selection=null,from=null){
  if(view==='manuscript'){openDocument(selection||{});openPanel('manuscript',null,from);return;}
  if(view==='execution'){
   composer.closeMenu?.();closePanel(false);overlay();
   const toolId=selection?.toolId;
   if(selection?.processId||!toolId||!(piView?.revealTool(toolId)||piManualView?.revealTool(toolId)))workspaceChrome?.revealTool(selection||{});
   announce('Tool details expanded in the conversation.');return;
  }
  if(!WORKSPACE_VIEWS.includes(view))return;
  const replaceFocusedView=q('#ac-workbench-slot').contains(document.activeElement)||q('#ac-knowledge-slot').contains(document.activeElement);
  showPanel(from);state.workspaceView=view;
  const moveFocus=selectSideView(view==='knowledge'?'knowledge':'workbench',({workflow:'Workflow',artifacts:'Artifacts',timeline:'Agent timeline',knowledge:'Knowledge'})[view]);
  layout?.refresh();overlay();
  if(view==='knowledge')knowledge?.open(selection||{});else workspaceViews?.open(view,selection);
  if((moveFocus||replaceFocusedView||root.dataset.panelLayout==='overlay')&&!q('#ac-research-panel').inert)(view==='knowledge'?knowledge:workspaceViews)?.focus?.();
  announce((view==='knowledge'?'Knowledge':view.charAt(0).toUpperCase()+view.slice(1))+' opened.');
 }
 function openAgents(id=null,from=null){
  const agent=workspaceStore?.getState().agents.find(item=>item.id===id);
  openWorkspace('timeline',agent?{taskId:agent.taskId,agentSessionId:agent.agentSessionId}:null,from);
 }
 function openApproval(id){
  settings?.close(false);
  if(!q('#ac-dialog-backdrop').hidden)closeDialog();
  return workspaceChrome?.openApproval(id);
 }
 function syncPanelToggle(open){const button=q('#ac-panel-toggle'),label=open?'Close side view':'Open side view';button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-pressed',String(open));button.setAttribute('aria-label',label);button.dataset.morphTooltip=label;button.innerHTML='<i data-lucide="'+(open?'panel-right-close':'panel-right-open')+'" aria-hidden="true"></i>';icons();}
 function closePanel(focusBack=true){if(!state.panelOpen)return;const hadFocus=q('#ac-research-panel').contains(document.activeElement);state.panelOpen=false;root.dataset.panelOpen='false';q('#ac-research-panel').hidden=true;syncPanelToggle(false);q('#ac-knowledge-nav').setAttribute('aria-expanded','false');overlay();layout?.refresh();announce('Side view closed. The conversation now has more space.');if(focusBack||hadFocus){const target=opener&&opener.isConnected&&!opener.closest('[hidden]')?opener:q('#ac-panel-toggle');target.focus({preventScroll:true})}}
 function setLeftOpen(open,focusBack=false){
  composer.closeMenu?.();state.leftOpen=Boolean(open);
  try{window.localStorage.setItem(LEFT_VISIBILITY_KEY,String(state.leftOpen))}catch(_){}
  syncLeftUI();layout?.refresh();overlay();drawChart();
  if(focusBack)(state.leftOpen?q('#ac-sidebar-collapse'):q('#ac-left-toggle')).focus({preventScroll:true});
  announce(state.leftOpen?'Projects expanded.':'Projects collapsed. Use the top-left icon to expand them.');
 }
 function toggleLeft(){setLeftOpen(!state.leftOpen,true)}
 function openSettings(section='general'){
  if(piWorkbench?.isDialogOpen())return;
  workspaceChrome?.closeApproval(false);
  composer.closeMenu?.();chatModelPicker?.close(false);command?.close?.(false);
  if(!q('#ac-dialog-backdrop').hidden)closeDialog();
  settings?.open(section);
 }
 function openPi(section='session'){openSettings('execution');settings?.routeRuntime?.(section);piWorkbench?.open(section)}
 function closeDialog(){q('#ac-dialog-backdrop').hidden=true;dialogAction=null;overlay();const target=dialogOpener?.isConnected&&!dialogOpener.closest('[hidden]')?dialogOpener:q('.ac-command-button');target?.focus({preventScroll:true})}
 function dialog(title,content,primary,action){dialogOpener=document.activeElement;composer.closeMenu?.();q('#ac-dialog-title').textContent=title;q('#ac-dialog-content').innerHTML=content;q('#ac-dialog-primary').hidden=!primary;q('#ac-dialog-primary').disabled=false;q('#ac-dialog-primary').textContent=primary||'';dialogAction=action||null;q('#ac-dialog-backdrop').hidden=false;overlay();q('.ac-dialog [data-action="close-dialog"]').focus({preventScroll:true});icons()}
 function escapeHTML(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
 function search(query){
  if(workspaceStore?.getState().mode==='runtime'){if(!q('#ac-dialog-backdrop').hidden)closeDialog();openWorkspace('knowledge',{query:String(query||'')});return;}
  const items=[
   {label:'Baseline circuit · baseline.cir',keywords:'baseline circuit input cir 기준 회로 입력',tab:'results',artifact:'baseline.cir'},
   {label:'Frequency response · Chart',keywords:'frequency response graph chart results cutoff 주파수 응답 그래프 결과 차단주파수',tab:'results',artifact:'response'},
   {label:'Validation results · Data',keywords:'validation results data values csv 검증 결과 데이터 수치',tab:'results',artifact:'table'},
   {label:'RC sensitivity analysis · Task',keywords:'sensitivity rc analysis task workflow 민감도 분석 작업 워크플로우',tab:'workflow'},
   {label:'Research note · Manuscript',keywords:'research note manuscript report 연구 노트 원고 보고서',tab:'manuscript'}
  ];
  const terms=String(query||'').trim().toLowerCase().split(/\s+/);
  const found=items.filter(i=>terms.every(t=>i.keywords.includes(t)));
  dialog('Find resources',found.length?'<div class="ac-search-results">'+found.map(i=>'<button class="ac-file-row cursor-interaction" data-search-result data-open="'+i.tab+'" '+(i.artifact?'data-artifact="'+i.artifact+'"':'')+'><i data-lucide="file" aria-hidden="true"></i>'+i.label+'<i data-lucide="arrow-up-right" aria-hidden="true"></i></button>').join('')+'</div>':'<p>No resources match “'+escapeHTML(query)+'”. Try circuit, response, task, or note.</p>');
 }
 function drawChart(){const el=q('#ac-response-chart');if(!el||q('#ac-research-panel').hidden||q('#ac-research-slot').hidden||q('#ac-view-results').hidden||q('#ac-result-response').hidden)return;const W=Math.max(230,Math.round(el.clientWidth||360)),H=220,L=42,R=22,T=25,B=42,pw=W-L-R,ph=H-T-B;const X=f=>L+(Math.log10(f)-1)/4*pw,Y=g=>T-g/40*ph;let line='',theory='';const fc=1/(2*Math.PI*1000*100e-9);for(let i=0;i<=120;i++){const f=10**(1+i/30),prefix=i?'L':'M';line+=prefix+X(f).toFixed(2)+' '+Y(-10*Math.log10(1+(f/1592)**2)).toFixed(2)+' ';theory+=prefix+X(f).toFixed(2)+' '+Y(-10*Math.log10(1+(f/fc)**2)).toFixed(2)+' ';}let svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Example RC frequency response: approximately minus 3 decibels at 1.592 kilohertz"><title>RC frequency response · example</title>';for(const g of [0,-10,-20,-30,-40])svg+='<line x1="'+L+'" y1="'+Y(g)+'" x2="'+(W-R)+'" y2="'+Y(g)+'" stroke="#e8e6dc" stroke-width=".7"/><text x="'+(L-9)+'" y="'+(Y(g)+4)+'" text-anchor="end" font-size="11" fill="#8d806c" font-family="Arial">'+g+'</text>';for(const [f,l] of (W<330?[[10,'10'],[1000,'1k'],[100000,'100k']]:[[10,'10'],[100,'100'],[1000,'1k'],[10000,'10k'],[100000,'100k']]))svg+='<text x="'+X(f)+'" y="'+(H-B+19)+'" text-anchor="middle" font-size="11" fill="#8d806c" font-family="Arial">'+l+'</text>';svg+='<text x="8" y="12" font-size="11" fill="#8d806c" font-family="Arial">Gain (dB)</text><text x="'+(W-R)+'" y="'+(H-3)+'" font-size="11" fill="#8d806c" text-anchor="end" font-family="Arial">Frequency (Hz)</text><path d="'+theory+'" fill="none" stroke="#a3a18f" stroke-width="4" opacity=".4"/><path d="'+line+'" fill="none" stroke="#c96442" stroke-width="2"/><line x1="'+X(1592)+'" x2="'+X(1592)+'" y1="'+T+'" y2="'+(H-B)+'" stroke="#c8bfaa" stroke-dasharray="3 4"/><circle cx="'+X(1592)+'" cy="'+Y(-3.0103)+'" r="3.7" fill="#c96442" stroke="#fff" stroke-width="1.5"/>';const ax=Math.min(X(1592)+7,W-94);svg+='<rect x="'+ax+'" y="'+(Y(-3.0103)+12)+'" width="76" height="29" rx="4" fill="#f3e9dd"/><text x="'+(ax+8)+'" y="'+(Y(-3.0103)+31)+'" font-size="11" fill="#8e624a" font-family="Arial">1.592 kHz</text></svg>';el.innerHTML=svg;}
 function mountDocumentToolbar(){
  recordToolbar?.destroy();
  recordToolbar=window.AthenaResearchRecords.mountToolbar(q('#ac-document-revisions'),{store:records,documentId:activeDocumentId,icons,toast,onVersion(revision){requestedDocumentVersion=null;renderDocumentRecord();paperPanel?.reload(revision.version);},onExport:downloadDocumentExport});
 }
 async function openDocument(selection={}){
  state.documentEditing=false;q('#ac-document-editor').hidden=true;q('#ac-editor-label').hidden=true;q('#ac-document').hidden=false;q('#ac-edit-manuscript').innerHTML='<i data-lucide="pencil" aria-hidden="true"></i>Edit';
  if(selection.documentId)activeDocumentId=selection.documentId;
  requestedDocumentVersion=selection.version||selection.documentVersion||null;mountDocumentToolbar();
  try{
   const id=activeDocumentId, version=requestedDocumentVersion, project=activeProjectId;
   const doc=records.getDocument(id);
   if(!doc && !selection.documentId)return;
   if(!doc||requestedDocumentVersion&&!doc.versions.some(item=>item.version===requestedDocumentVersion))await records.loadDocument(activeDocumentId,requestedDocumentVersion||undefined);
   if(id!==activeDocumentId||version!==requestedDocumentVersion||project!==activeProjectId)return;
   if(requestedDocumentVersion)records.selectVersion(activeDocumentId,requestedDocumentVersion);
  }catch(error){toast(String(error.message||error));}
  renderDocumentRecord();
 }
 function renderDocumentRecord(){
  if(!records)return;
  const doc=records.getDocument(activeDocumentId);
  q('#ac-edit-manuscript').disabled=!doc;
  if(!doc){q('#ac-document-status').textContent='No document in this project';q('#ac-document').textContent='Open a project document from Artifacts to read or edit its version.';q('#ac-document-editor').value='';return;}
  if(requestedDocumentVersion&&!doc.versions.some(version=>version.version===requestedDocumentVersion)){q('#ac-document-status').textContent='Requested version is unavailable';q('#ac-document').textContent='The document service has not provided '+activeDocumentId+' · v'+requestedDocumentVersion+'.';q('#ac-document-editor').value='';q('#ac-document-editor').readOnly=true;q('#ac-edit-manuscript').disabled=true;return;}
  const selected=doc.versions.find(version=>version.version===doc.selectedVersion);
  if(!selected)return;
  if(workspaceStore?.getState().mode==='runtime'&&selected.originalSample&&selected.persistence!=='host'){q('#ac-document-status').textContent='Project document not connected';q('#ac-document').textContent='Open a document with a confirmed project ID and version from Artifacts.';q('#ac-document-editor').value='';q('#ac-document-editor').readOnly=true;q('#ac-edit-manuscript').disabled=true;return;}
  const text=doc.selectedVersion===doc.currentVersion&&doc.draft.dirty?doc.draft.text:selected.text;
  if(q('#ac-document-editor').value!==text)q('#ac-document-editor').value=text;
  q('#ac-document-editor').readOnly=doc.selectedVersion!==doc.currentVersion;
  q('#ac-document-status').textContent=doc.documentId+' · v'+doc.selectedVersion+' · '+(doc.draft.dirty&&doc.selectedVersion===doc.currentVersion?'Edited draft · Unreviewed':selected.review.status.replaceAll('_',' '))+' · '+(selected.persistence==='host'?'Stored in project':'This session');
  if(displayedNote!==text||q('#ac-document').dataset.version!==doc.selectedVersion||q('#ac-document').dataset.documentId!==doc.documentId){
   displayedNote=text;const article=q('#ac-document');article.replaceChildren();article.dataset.documentId=doc.documentId;article.dataset.version=doc.selectedVersion;
   for(const [index,part] of text.split(/\n\n+/).entries()){if(index)article.appendChild(document.createTextNode('\n\n'));const element=document.createElement(index===0?'h2':'p');element.style.whiteSpace='pre-wrap';element.textContent=part;article.appendChild(element);}
  }
 }
 function downloadDocumentExport(result){
  if(!result?.location?.uri||result.documentId!==activeDocumentId)return;
  const url=new URL(result.location.uri,document.baseURI||'https://invalid.local/');
  if(!['https:','http:','blob:'].includes(url.protocol)){toast('The document service must provide a downloadable file URL.');return;}
  const anchor=document.createElement('a');anchor.href=url.href;anchor.download=result.documentId+'-v'+result.version+'.pdf';anchor.rel='noopener';anchor.click();
  toast('PDF export confirmed for '+result.documentId+' · v'+result.version+'.');
 }
 function renderWorkspace(snapshot){
  const previousSession=root.dataset.sessionId;
  if(snapshot.mode==='runtime'&&previousSession&&snapshot.sessionId!==previousSession&&(snapshot.sessionId||snapshot.taskManagerConnected)&&!lifecyclePending){
   sessionDrafts.set(previousSession,composer.captureDraft());preservePendingSubmission('The workspace switched conversations.');resetPiActivity();
   piView?.clear?.();q('#ac-pi-transcript').hidden=true;q('#ac-live-user').hidden=true;piHistorySignature='';piManualTools.clear();piManualView?.reset();
   composer.restoreDraft(sessionDrafts.get(snapshot.sessionId||'preview')||{value:'',attachments:[],mentions:[]});
  }
  const live=snapshot.mode==='runtime';root.dataset.workspaceMode=snapshot.mode;root.dataset.sessionBound=String(snapshot.sessionBound!==false);
  paperPanel?.scope(snapshot);researchFlow?.scope(snapshot);
  const guided=snapshot.projects?.some(p=>p.id===snapshot.projectId&&p.researchWorkflow)&&!!snapshot.sessionId;
  q('#ac-view-manuscript').dataset.guided=String(!!guided);
  if(guided&&shownResearchSession!==snapshot.sessionId){
    shownResearchSession=snapshot.sessionId;q('#ac-view-manuscript').dataset.editorOpen='false';openPanel('manuscript');
  }
  if(live){q('#ac-doc-evidence').hidden=true;q('[data-action="export-manuscript"]').hidden=true;}
  surfaces?.setRuntimeMode?.(live);
  knowledge?.setRuntimeMode?.(live);
  for(const [key,value] of [['projectId',snapshot.projectId],['sessionId',snapshot.sessionId],['runId',snapshot.run?.id]])root.dataset[key]=value||'';
  const activity=q('#aw-activity');
  if(live&&activity.parentElement!==q('#ac-connected-activity'))q('#ac-connected-activity').appendChild(activity);
  if(!live&&activity.parentElement!==activityHome)activityHome.insertBefore(activity,activityBefore);
  const projectId=snapshot.projectId||(live?'unassigned-project':'project-rc');
  if(projectId!==activeProjectId){activeProjectId=projectId;activeDocumentId='research-note';requestedDocumentVersion=null;knowledge?.setProject(projectId);records?.setProject(projectId);renderDocumentRecord();}
  modelSettings?.setExecution(snapshot.execution || null);
  const m3Scopes=modelProfilesAdapter?providerProfiles?.resolveScopes(snapshot):null;
  modelSettings?.setModelScopes(m3Scopes||snapshot.modelScopes||{},{canEditProject:Boolean(snapshot.capabilities?.setProjectModel)});
  if(modelProfilesAdapter){
   const session=(snapshot.sessions||[]).find(item=>item.id===snapshot.sessionId),project=(snapshot.projects||[]).find(item=>item.id===snapshot.projectId);
   chatModelPicker?.setProfileContext?.({sessionId:snapshot.sessionId||null,researchWorkflow:!!project?.researchWorkflow,profileId:session?.profileId||null,projectId:snapshot.projectId||null,projectDefaultProfileId:project?.defaultProfileId||null,appDefaultProfileId:providerProfiles?.getAppDefaultProfileId()||null,hostModel:providerProfiles?.getHostModel()||null});
  }
  chatModelPicker?.sync();
  q('#ac-example-projects').hidden=live;q('#ac-live-projects').hidden=!live;
  const signature=JSON.stringify([live,snapshot.projects,snapshot.sessions,snapshot.sessionId,snapshot.projectId,snapshot.taskManagerStatus]);
  if(signature!==projectSignature){
   projectSignature=signature;const list=q('#ac-live-projects');list.replaceChildren();
   if(live&&!snapshot.projects.length){const info=document.createElement('p');info.className='ac-project-empty';info.textContent=snapshot.taskManagerConnected?'No projects yet.':snapshot.taskManagerStatus==='connecting'?'Loading projects…':'Project storage is not connected.';list.appendChild(info);}
   for(const project of snapshot.projects||[]){
    const group=document.createElement('details');group.open=project.id===snapshot.projectId;group.className='ac-live-project';
    const summary=document.createElement('summary');summary.className='ac-project-label cursor-interaction';summary.textContent=window.AthenaActivityLabels.text(project.name,'Untitled project',[project.id]);group.appendChild(summary);
    if(project.folder){const info=document.createElement('small');info.textContent=[project.folder.path,project.folder.branch].filter(Boolean).join(' · ');info.className='ac-project-empty';group.append(info);}
    if(project.id===snapshot.projectId){const stage=document.createElement('small');stage.id='ac-flow-stage';stage.textContent=currentResearchStage;stage.className='ac-project-empty';group.append(stage);}
    for(const session of (snapshot.sessions||[]).filter(item=>item.projectId===project.id)){const button=document.createElement('button');button.type='button';button.className='ac-thread-item cursor-interaction';button.dataset.openSession=session.id;button.textContent=window.AthenaActivityLabels.text(session.title,'New conversation',[session.id]);if(session.id===snapshot.sessionId)button.setAttribute('aria-current','page');button.disabled=!snapshot.capabilities?.openSession;group.appendChild(button);}
    if(project.researchWorkflow&&!snapshot.sessions.some(s=>s.projectId===project.id)){
      const first=document.createElement('button');first.type='button';first.className='ac-thread-item';first.textContent='Open first conversation';
      first.onclick=async()=>{try{await createResearch('Research',project.id,true);}catch(e){first.textContent='Retry · '+e.message;}};group.append(first);
    }
    list.appendChild(group);
   }
  }
  if(live){
   const current=(snapshot.sessions||[]).find(item=>item.id===snapshot.sessionId),project=(snapshot.projects||[]).find(item=>item.id===snapshot.projectId);
   q('#ac-thread-title').textContent=window.AthenaActivityLabels.text(current?.title,'New conversation',[snapshot.sessionId]);
   q('.ac-header-title > span').textContent=window.AthenaActivityLabels.text(project?.name,'Connected workspace',[snapshot.projectId]);
   q('.ac-composer-caption > span').lastChild.textContent=window.AthenaActivityLabels.text(project?.name,'No project selected',[snapshot.projectId]);
   if(!piSession)q('#ac-pi-session-status').textContent=snapshot.taskManagerConnected?'TaskManager connected · model session not connected':'Workspace service is not connected';
   if(snapshot.sessionBound===false){q('#ac-pi-session-status').textContent='Connect the model to this conversation';preservePendingSubmission('The selected conversation is no longer bound to the model connection.');if(piEngaged)resetPiActivity();}
  }
  piView?.refresh();piManualView?.refresh();settings?.refresh?.();extensions?.setWorkspace();icons();
 }
 function resolvedNewSessionModel(workspace,projectId){const projectModel=projectId===workspace.projectId?workspace.modelScopes?.projectDefault:workspace.projects.find(project=>project.id===projectId)?.defaultModel;return projectModel||connectionManager.getDefaultModel()||null;}
 function canCreateSession(){return !nativeSessionTransition&&Boolean(workspaceStore.getState().capabilities?.createSession||connectionManager.getState().capabilities.createSession||piRuntime.available('new_session'));}
 function rememberDraft(){const key=workspaceStore.getState().sessionId||'preview';sessionDrafts.set(key,composer.captureDraft());}
 function activateSession(result,title){
  const sessionId=result?.sessionId||result?.session?.id;
  if(!sessionId)throw new Error('The host did not confirm a new session identifier. The current draft is unchanged.');
  preservePendingSubmission('The active conversation changed before the host accepted the message.');
  workspaceStore.confirmSession({...result,sessionId,title:result.title||result.session?.title||title||sessionId});
  if(result.connection)attachPiSession(result.connection,{label:result.connection.label});
  resetPiActivity();piView?.clear?.();piHistorySignature='';q('#ac-live-user').hidden=true;
  q('#ac-thread-title').textContent=result.title||result.session?.title||title||sessionId;
  composer.restoreDraft(sessionDrafts.get(sessionId)||{value:'',attachments:[],mentions:[]});
  closeDialog();composer.focus();return result;
 }
 async function createResearch(title,projectId=workspaceStore.getState().projectId,firstForProject=false){
  if(lifecyclePending)return;
  if(!canCreateSession())throw new Error('Connect a session service or Pi session before creating a conversation.');
  if(state.busy||piSubmitting||piRuntime.getState().session.isStreaming)throw new Error('Wait for the current message operation to finish before creating a conversation.');
  lifecyclePending=true;rememberDraft();
  try{
   const workspace=workspaceStore.getState(),preferred=resolvedNewSessionModel(workspace,projectId);let result;
   const input={...(firstForProject?{firstForProject}:{}),projectId:workspace.mode==='runtime'?projectId:null,title,model:preferred,configurationId:connectionManager.getState().configurationId||undefined};
   if(workspace.capabilities?.createSession)result=await workspaceStore.createSession(input);
   else if(connectionManager.getState().capabilities.createSession)result=await connectionManager.createSession(input);
   else{
    if(preferred&&!piRuntime.getState().models.some(item=>item.provider===preferred.provider&&item.id===preferred.modelId))throw new Error('The configured default model is not available to this connection. Choose an available default before creating a conversation.');
    const binding=piSession,epoch=piSessionEpoch,previousId=piRuntime.getState().session.sessionId||piRuntime.getState().session.id;
    const assertBinding=()=>{const current=piRuntime.getState().session.sessionId||piRuntime.getState().session.id;if(appDestroyed||piSession!==binding||piSessionEpoch!==epoch||result?.sessionId&&current!==result.sessionId)throw new Error('The model connection changed during session creation. The previous draft is preserved.');};
    nativeSessionTransition={binding,epoch,previousId,title,created:false};
    let created;
    try{created=await piRuntime.execute('new_session');assertBinding();}catch(error){nativeSessionTransition=null;throw error;}
    if(created?.cancelled){nativeSessionTransition=null;throw new Error('The host cancelled session creation. Your draft is preserved.');}
    nativeSessionTransition.created=true;
    try{await piRuntime.execute('get_state');assertBinding();}catch(error){assertBinding();toast('Session creation was accepted, but its identity could not be refreshed.');}
    const actual=piRuntime.getState().session,sessionId=actual.sessionId||actual.id||created?.sessionId;
    if(!sessionId||sessionId===previousId)throw new Error('Session creation was accepted. Refresh the connection in Settings to confirm the new session before sending or creating another conversation. Your previous draft is preserved.');
    result={sessionId,title:actual.sessionName||title,projectId:input.projectId};nativeSessionTransition=null;
    activateSession(result,title);
    try{
     assertBinding();
     if(title&&piRuntime.available('set_session_name')){await piRuntime.execute('set_session_name',{name:title});assertBinding();}
     if(preferred){await piRuntime.execute('set_model',{provider:preferred.provider,modelId:preferred.modelId});assertBinding();await piRuntime.refresh();assertBinding();if(preferred.thinkingLevel&&piRuntime.getState().thinkingLevels.includes(preferred.thinkingLevel)){await piRuntime.execute('set_thinking_level',{level:preferred.thinkingLevel});assertBinding();}}
    }catch(error){toast('Conversation created. Some initial settings were not applied: '+String(error.message||error));}
    return result;
   }
   return activateSession(result,title);
  }finally{lifecyclePending=false;}
 }
 async function openResearchSession(sessionId){
  if(lifecyclePending||piSubmitting||nativeSessionTransition||state.busy){toast('Wait for the current operation to finish.');return;}
  lifecyclePending=true;rememberDraft();
  try{activateSession(await workspaceStore.openSession(sessionId));}catch(error){toast(String(error.message||error));}finally{lifecyclePending=false;}
 }
 function requestProject(){
  const requestId=crypto.randomUUID();let created=null;
  const enabled=Boolean(workspaceStore.getState().capabilities?.createProject);
  dialog('New project','<p>Create a separate place for conversations, sources, and versioned documents.</p><label for="ac-project-name">Project name</label><input id="ac-project-name" aria-label="Project name" placeholder="Your research project"><label for="ac-project-folder">Work folder or Git repository (optional)</label><input id="ac-project-folder" placeholder="Absolute local folder path"><button id="ac-choose-folder" type="button" hidden>Choose folder…</button><label class="ac-research-choice"><input type="checkbox" id="ac-research-mode" checked><span>Enable research, paper archiving and typesetting</span></label><p class="ac-small-note">'+(enabled?'The connected project service will store this project.':'Project storage is not connected. A project will be created only after the service confirms it.')+'</p><p data-lifecycle-error role="alert" hidden></p>','Create project',async()=>{
   const input=q('#ac-project-name'),name=input.value.trim();
   if(!name){const message=q('[data-lifecycle-error]');message.hidden=false;message.textContent='Enter a project name.';input.setAttribute('aria-invalid','true');input.focus();return;}
   input.removeAttribute('aria-invalid');
   q('#ac-dialog-primary').disabled=true;
   try{
    if(!created){const result=await workspaceStore.createProject({name,requestId,folder:q('#ac-project-folder').value.trim(),researchWorkflow:q('#ac-research-mode').checked,defaultModel:connectionManager.getDefaultModel()});created=result?.project;}
    if(!created?.id)throw new Error('Project creation was not confirmed.');
    q('#ac-project-name').disabled=q('#ac-project-folder').disabled=q('#ac-research-mode').disabled=true;
    q('#ac-dialog-primary').textContent='Retry opening conversation';
    await createResearch('Research',created.id,true);
    if(created.researchWorkflow)openPanel('manuscript');composer.focus();
   }
   catch(error){const message=q('[data-lifecycle-error]');if(message){message.hidden=false;message.textContent=String(error.message||error);}}
   finally{q('#ac-dialog-primary').disabled=!enabled;}
  });q('#ac-dialog-primary').disabled=!enabled;q('#ac-project-name').focus();
  const pick=q('#ac-choose-folder');pick.hidden=!window.AthenaFolderPicker;
  pick.onclick=async()=>{try{const path=await window.AthenaFolderPicker();if(path)q('#ac-project-folder').value=path;}catch(e){const msg=q('[data-lifecycle-error]');msg.hidden=false;msg.textContent=e.message;}};
 }
 function requestResearch(){
  const workspace=workspaceStore.getState(),enabled=canCreateSession();
  const projects=workspace.capabilities?.createSession?workspace.projects:[];
  const picker=projects.length?'<label for="ac-new-project">Project</label><select id="ac-new-project">'+projects.map(project=>'<option value="'+escapeHTML(project.id)+'"'+(project.id===workspace.projectId?' selected':'')+'>'+escapeHTML(project.name)+'</option>').join('')+'</select>':'';
  dialog('New research','<p>Create a new conversation in '+(picker?'the selected project.':'the current project.')+'</p>'+picker+'<label for="ac-new-thread">Conversation title</label><input id="ac-new-thread" aria-label="Conversation title" placeholder="What are you researching?"><p class="ac-small-note" id="ac-new-model"></p><button type="button" class="ac-text-button cursor-interaction" data-action="current-draft">Write in the current conversation instead</button><p data-lifecycle-error role="alert" hidden></p>','Create conversation',async()=>{
   const title=q('#ac-new-thread').value.trim();if(!title)return;
   q('#ac-dialog-primary').disabled=true;
   try{await createResearch(title,q('#ac-new-project')?.value);}catch(error){const message=q('[data-lifecycle-error]');if(message){message.hidden=false;message.textContent=String(error.message||error);}else toast(String(error.message||error));}
   finally{q('#ac-dialog-primary').disabled=!canCreateSession();}
  });
  const select=q('#ac-new-project');
  const updateModel=()=>{const model=resolvedNewSessionModel(workspace,select?.value??workspace.projectId);q('#ac-new-model').textContent=enabled?'Model: '+(model?model.provider+' / '+model.modelId:'The connected session default'):'A session service is not connected. Your current conversation remains unchanged.';};
  select?.addEventListener('change',updateModel);updateModel();q('#ac-dialog-primary').disabled=!enabled;q('#ac-new-thread').focus();
 }
 async function preparePiContext(value,attachments,mentions){
  if(mentions.length)throw new Error('Sample project context is still in the draft. Use an installed command or paste the source text for this session.');
  piRuntime.validateMessage(value);
  const contract=piRuntime.getInputContract(), model=piRuntime.getState().model;
  for(const file of attachments)if(/^image\/(png|jpeg|webp|gif)$/.test(file.type||'')&&Array.isArray(model?.input)&&!model.input.includes('image'))throw new Error('The selected model does not accept images. Your attachments remain in the draft.');
  if(attachments.length&&contract.supportsFileReferences&&contract.canStageFiles){
   const context=workspaceStore?.getState(), current=piRuntime.getState();
   const staged=await piSession.stageFiles(attachments,{projectId:context?.mode==='runtime'?context.projectId:null,sessionId:current.session.sessionId||current.session.id||null});
   return {message:value,fileReferences:staged.fileReferences};
  }
  const images=[],parts=[value];
  for(const file of attachments){
   if(/^image\/(png|jpeg|webp|gif)$/.test(file.type||'')){
    if(!piSession?.supportsImages)throw new Error('This connection accepts text only. Image attachments remain in your draft.');
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    images.push({type:'image',mimeType:file.type,data:btoa(binary)});
   }else if(/^text\//.test(file.type||'')||/\.(txt|md|csv|tsv|json|jsonl|yaml|yml|py|js|ts|tsx|jsx|html|css|c|h|cpp|rs|sh|sql|log|cir)$/i.test(file.name)){
    if(file.size>1024*1024)throw new Error('This file needs a connected file-reference service because it exceeds the inline file limit of 1 MB. Nothing was sent; the file remains in your draft.');
    parts.push('[Attached file: '+file.name+']\n'+await file.text()+'\n[End attached file]');
   }else throw new Error('This file type requires a connected file-reference service. Nothing was sent; the file remains in your draft.');
  }
  const message=parts.filter(part=>part!=='').join('\n\n');
  piRuntime.validateMessage(message);
  return {message,...(images.length?{images}:{})};
 }
 function archiveLiveTurn(){
  if(!piEngaged)return;
  piView?.reset();q('#ac-live-user').hidden=true;
 }
 function sameDraftContext(files,mentions){return files.length===composer.getAttachments().length&&files.every((file,i)=>file===composer.getAttachments()[i])&&JSON.stringify(mentions.map(m=>m.id))===JSON.stringify(composer.getSelections().map(m=>m.id))}
 function keepUnsent(draft,reason){
  failedDrafts.push({value:draft.value,attachments:[...draft.attachments],mentions:[...draft.mentions],sessionId:draft.sessionId||null,reason});
  q('#ac-unsent-draft').hidden=false;q('#ac-unsent-draft span').textContent=failedDrafts.length+' unsent message'+(failedDrafts.length===1?' is':'s are')+' kept with attachments.';
 }
 function preservePendingSubmission(reason){if(!piSubmittedContext)return;const pending=piSubmittedContext;piSubmittedContext=null;keepUnsent(pending,reason);}
 function conversationBinding(){const workspace=workspaceStore?.getState();return {projectId:workspace?.projectId||null,sessionId:workspace?.sessionId||null,piSessionId:piRuntime.getState().session.sessionId||piRuntime.getState().session.id||null};}
 function sameConversation(binding){const current=conversationBinding();return workspaceStore?.getState().sessionBound!==false&&binding.projectId===current.projectId&&binding.sessionId===current.sessionId&&binding.piSessionId===current.piSessionId;}
 function acceptSubmittedContext(){
  const submitted=piSubmittedContext;if(!submitted)return;
  if(submitted.session===piSession&&submitted.epoch===piSessionEpoch&&submitted.turn===piTurnEpoch&&composer.getValue()===''&&sameDraftContext(submitted.attachments,submitted.mentions))composer.clearContext();
  piSubmittedContext=null;
 }
 async function submit(text,metadata={}){
  if(state.busy||piSubmitting)return;
  if(lifecyclePending||nativeSessionTransition){toast('Wait for the new conversation to be confirmed. Your draft is preserved.');return;}
  if(workspaceStore?.getState().sessionBound===false){toast('Connect the model to the active conversation before sending. Your draft is preserved.');return;}
  if(piSession&&piRuntime?.getState().busy.some(id=>['set_model','cycle_model','set_thinking_level','cycle_thinking_level'].includes(id))){toast('Wait for the model selection to finish. Your draft is still here.');return;}
  if(piSession&&piRuntime?.getState().session.isCompacting){toast('Context compaction is still running. Your draft is ready to send when it finishes.');return;}
  const value=String(text||''),attachments=Array.isArray(metadata.attachments)?metadata.attachments:[],mentions=Array.isArray(metadata.mentions)?metadata.mentions:[];
  if(!value.trim()&&!attachments.length&&!mentions.length)return;
  if(!piSession&&workspaceStore?.getState().mode!=='demo'){toast('Connect a model to send this message, or enable Development demo in Settings. Your draft and files are preserved.');return;}
  if(workspaceStore?.getState().mode==='runtime'&&!piSession){toast('Connect a model session before sending. Your draft and files are unchanged.');return;}
  let prepared={message:value};
  if(piSession){
   if(typeof piSession.prompt!=='function'){toast('This connected session is view-only.');return}
   const binding=piSession,epoch=piSessionEpoch,turn=piTurnEpoch,conversation=conversationBinding();
   piSubmitting=true;try{prepared=await preparePiContext(value,attachments,mentions)}catch(error){toast(String(error.message||error));return}finally{piSubmitting=false}
   if(appDestroyed||piSession!==binding||piSessionEpoch!==epoch||turn!==piTurnEpoch||!sameConversation(conversation)){if(!appDestroyed)toast('The active conversation changed. Nothing was sent; your draft is preserved.');return;}
   archiveLiveTurn();
  }
  chatModelPicker?.close(false);clearPiPreview();piEngaged=false;piRunId=null;piText='';piActivity?.reset();piView?.reset();
  state.busy=true;
  state.lastSubmission={text:value,attachments:attachments.map(file=>({name:file.name,size:file.size,type:file.type})),mentions:mentions.map(item=>({id:item.id,label:item.label,kind:item.kind}))};
  const message=q('#ac-live-user');message.replaceChildren();
  if(value){const content=document.createElement('div');content.textContent=value;message.appendChild(content)}
  if(attachments.length){
   const list=document.createElement('div');list.className='ac-message-attachments';
   for(const file of attachments){const item=document.createElement('span');item.className='ac-message-attachment';const icon=document.createElement('i');icon.dataset.lucide=file.type?.startsWith('image/')?'image':'paperclip';icon.setAttribute('aria-hidden','true');const label=document.createElement('span');label.textContent=file.name;item.append(icon,label);list.appendChild(item)}
   message.appendChild(list);
  }
  message.hidden=false;q('#ac-live-reply').hidden=false;if(composer.getValue()===value)composer.setValue('');if(!piSession&&sameDraftContext(attachments,mentions))composer.clearContext();composer.setBusy(true,'Waiting',{canStop:!piSession||typeof piSession.abort==='function'});icons();
  if(piSession){
   piEngaged=true;piView.beginUser(value,attachments);q('#ac-live-user').hidden=true;reply.setConversationMode(true);reply.begin({phase:'waiting'});
   const activeSession=piSession,epoch=piSessionEpoch,turn=piTurnEpoch,conversation=conversationBinding();
   piSubmittedContext={session:activeSession,epoch,turn,value,attachments,mentions,sessionId:conversation.sessionId};
   Promise.resolve().then(()=>{if(appDestroyed||piSession!==activeSession||piSessionEpoch!==epoch||piTurnEpoch!==turn||!sameConversation(conversation))throw new Error('The active conversation changed before this message was sent.');return activeSession.prompt(prepared.message,{images:prepared.images,fileReferences:prepared.fileReferences});}).then(result=>{
    if(appDestroyed||piSession!==activeSession||piSessionEpoch!==epoch||piTurnEpoch!==turn)return;
    if(['started','handled','queued'].includes(result?.disposition))acceptSubmittedContext();
    if(['handled','queued'].includes(result?.disposition)&&piActivity.getState().sequence===0){reply.stop();q('#ac-live-reply').hidden=true;piEngaged=false;state.busy=false;composer.setBusy(false);chatModelPicker?.sync();toast(result.disposition==='queued'?'Message queued.':'Handled by an extension.');}
   }).catch(error=>{
    if(appDestroyed||piSession!==activeSession||piSessionEpoch!==epoch||piTurnEpoch!==turn)return;
    const unaccepted=Boolean(piSubmittedContext);piSubmittedContext=null;
    handlePiEvent({type:'message_end',message:{role:'assistant',content:[{type:'text',text:piActivity.getState().text}],stopReason:'error',errorMessage:String(error?.message||error)}});
    handlePiEvent({type:'agent_settled',aborted:false});
    if(unaccepted){const unchanged=composer.getValue()===''&&sameDraftContext(attachments,mentions),empty=composer.getValue()===''&&!composer.getAttachments().length&&!composer.getSelections().length;if(unchanged||empty)composer.restoreDraft({value,attachments,mentions});else keepUnsent({value,attachments,mentions,sessionId:conversation.sessionId},String(error.message||error));}
   });
   const scroller=q('.ac-conversation-inner');scroller.scrollTop=scroller.scrollHeight;return;
  }
  const response=attachments.length?'Added '+attachments.map(file=>file.name).join(', ')+' to this conversation. This preview shows how attachments work; it has not analyzed the files or run a calculation. A connected runtime can receive these files and the selected tools.':'To compare component tolerances, first define the resistor and capacitor ranges. For example, use ±1% for the resistor and ±5% for the capacitor. The next step would be to compare the cutoff frequencies with the baseline circuit. This is a sample response; no calculation has been submitted.';
  reply.setConversationMode(false);reply.start({text:response,onPhase(phase,descriptor){if(state.busy&&descriptor.active)composer.setBusy(true,descriptor.label)},onDone(){state.busy=false;composer.setBusy(false);chatModelPicker?.sync();announce('Sample response complete.')}});
  const scroller=q('.ac-conversation-inner');scroller.scrollTop=scroller.scrollHeight;
 }
 const reply=window.AthenaReply.mount(q('#ac-live-reply'));
 const composer=window.AthenaComposer.mount(q('#ac-composer-slot'),{hosted,onSubmit:submit,onMention:item=>announce((item.label||item.name||'Resource')+' added to the prompt.'),onStop:stopResponse});
 async function sendQueuedDraft(){
  if(!piSession||piSubmitting)return;
  if(lifecyclePending||nativeSessionTransition){toast('Wait for the active conversation to be confirmed.');return;}
  if(workspaceStore?.getState().sessionBound===false){toast('Connect the model to this conversation before queuing a message.');return;}
  const message=composer.getValue(),files=composer.getAttachments(),mentions=composer.getSelections(),mode=q('#ac-pi-delivery').value;
  if(!message&&!files.length)return;
  const binding=piSession,epoch=piSessionEpoch,turn=piTurnEpoch,conversation=conversationBinding();piSubmitting=true;q('#ac-pi-send-queued').disabled=true;
  try{
   const prepared=await preparePiContext(message,files,mentions);
   if(appDestroyed||piSession!==binding||epoch!==piSessionEpoch||turn!==piTurnEpoch||!sameConversation(conversation)){if(!appDestroyed)toast('The active conversation changed. Your queued draft is preserved.');return;}
   const result=await piRuntime.execute(mode,prepared);
   if(appDestroyed||piSession!==binding||epoch!==piSessionEpoch||turn!==piTurnEpoch||!sameConversation(conversation))return;
   if(composer.getValue()===message){composer.setValue('');if(sameDraftContext(files,mentions))composer.clearContext();}
   toast(result?.disposition==='handled'?'Handled by an extension.':mode==='steer'?'Instruction sent to the current run.':'Follow-up queued.');
  }catch(error){if(epoch===piSessionEpoch)toast(String(error.message||error))}
  finally{piSubmitting=false;if(!appDestroyed)q('#ac-pi-send-queued').disabled=false}
 }
 function clearPiPreview(){for(const timer of piPreviewTimers)clearTimeout(timer);piPreviewTimers.clear();piPreviewActive=false}
 function stopResponse(){
  if(piPreviewActive){clearPiPreview();piActivity.receive({type:'agent_settled',aborted:true});return}
  if(piEngaged&&piSession&&typeof piSession.abort==='function'){
   composer.setBusy(true,'Stopping…',{canStop:false});
   const activeSession=piSession,epoch=piSessionEpoch,turn=piTurnEpoch;
   Promise.resolve().then(()=>{if(!appDestroyed&&piSession===activeSession&&piSessionEpoch===epoch&&turn===piTurnEpoch)return activeSession.abort()}).catch(error=>{if(!appDestroyed&&piSession===activeSession&&piSessionEpoch===epoch&&turn===piTurnEpoch){composer.setBusy(false);composer.setBusy(true,piActivity.getState().label);toast('The stop request failed. '+String(error?.message||error))}});
   return;
  }
  if(piEngaged)return;
  reply.stop();state.busy=false;composer.setBusy(false);chatModelPicker?.sync();announce('Sample response stopped.');
 }
 function renderPiActivity(snapshot){
  if(appDestroyed||snapshot.sequence===0)return;
  if(workspaceStore?.getState().sessionBound===false)return;
  if(!piEngaged&&snapshot.settled&&snapshot.phase==='idle'&&!snapshot.tools.length&&!snapshot.messages.length)return;
  beforeConversationLayout();
  try{
  q('#ac-live-reply').hidden=false;
  if(piRunId!==snapshot.runId||!piEngaged){
   piRunId=snapshot.runId;piText='';piEngaged=true;
   reply.begin({phase:snapshot.phase,previewLabel:piPreviewActive?'Local event preview':''});
  }
  reply.setConversationMode(true);piView.render(snapshot);workspaceStore?.observeActivity?.(snapshot);
  if(snapshot.text!==piText){
   if(snapshot.text.startsWith(piText))reply.append(snapshot.text.slice(piText.length));else reply.replaceText(snapshot.text);
   piText=snapshot.text;
  }
  reply.setPhase(snapshot.phase);
  if(snapshot.settled){
   const justSettled=state.busy;
   reply.end({text:snapshot.text,status:snapshot.phase,detail:snapshot.error||''});
   state.busy=false;composer.setBusy(false);clearPiPreview();
   if(justSettled&&piSession&&piRuntime.available('get_messages')){
    // Only a history read accepted after settlement can replace this live turn.
    // A prefix read accepted during streaming must not erase its later messages.
    piHistoryAfterSettle=piRuntime.getState().historyRevision||0;
   }
  }else{
   state.busy=true;composer.setBusy(true,snapshot.label,{canStop:piPreviewActive||typeof piSession?.abort==='function'});
  }
  chatModelPicker?.sync();
  }finally{afterConversationLayout()}
 }
 function handlePiEvent(event){if(appDestroyed)return false;return piRuntime?piRuntime.receive(event):piActivity.receive(event)}
 function usePiDraft(text){
  const draft=String(text||'');if(!draft)return;
  composer.setValue((composer.getValue().trim()?composer.getValue()+'\n\n':'')+draft);
  piDraftOffer='';q('#ac-pi-draft-offer').hidden=true;settings?.close(false);overlay();composer.focus();
 }
 function renderPiShell(snapshot){
  if(appDestroyed)return;
  root.dataset.piConnected=String(snapshot.connected);
  const currentId=snapshot.session.sessionId||snapshot.session.id||'';
  if(snapshot.connected&&currentId&&piSessionIdentity&&currentId!==piSessionIdentity){
   piTurnEpoch++;preservePendingSubmission('The model connection changed conversations.');resetPiActivity();q('#ac-live-user').hidden=true;piView?.clear?.();piHistorySignature='';piManualTools.clear();piManualView?.reset();
  }
  if(currentId)piSessionIdentity=currentId;
  if(snapshot.connected&&snapshot.session.sessionName&&workspaceStore?.getState().sessionBound!==false)q('#ac-thread-title').textContent=window.AthenaActivityLabels.text(snapshot.session.sessionName,'New conversation',[snapshot.session.sessionId,snapshot.session.id]);
  const percent=Number.isFinite(snapshot.context?.percent)?Math.round(snapshot.context.percent):null;
  q('#ac-pi-session-status').textContent=snapshot.connected?(snapshot.session.isCompacting?'Compacting context':snapshot.session.isStreaming?'Pi is working':snapshot.connectionLabel)+(percent===null?'':' · '+percent+'% context'):workspaceStore?.getState().mode==='runtime'?'Model session is not connected':'UI preview · sample data';
  const queued=snapshot.queues.steering.length+snapshot.queues.followUp.length;
  q('#ac-pi-queue-count').textContent=queued+' queued';
  q('#ac-pi-queue-controls').hidden=!snapshot.connected||(!snapshot.session.isStreaming&&!state.busy&&!queued);
  const delivery=q('#ac-pi-delivery');
  for(const option of delivery.options||[])option.disabled=!snapshot.capabilities[option.value]?.available;
  if(!snapshot.capabilities[delivery.value]?.available){const choice=['steer','follow_up'].find(id=>snapshot.capabilities[id]?.available);if(choice)delivery.value=choice;}
  q('#ac-pi-send-queued').disabled=piSubmitting||!snapshot.capabilities[delivery.value]?.available;
  const commands=JSON.stringify([snapshot.connected,snapshot.resources.commands]);
  if(commands!==piCommandSignature){piCommandSignature=commands;composer.setRuntimeCommands?.(snapshot.resources.commands,{connected:snapshot.connected});}
  const widgetSignature=JSON.stringify([snapshot.ui.statuses,snapshot.ui.widgets]);
  if(widgetSignature!==piWidgetSignature){
   piWidgetSignature=widgetSignature;
   const statuses=q('#ac-pi-statuses');statuses.replaceChildren();
   for(const status of snapshot.ui.statuses){const s=document.createElement('span');s.textContent=status.text;statuses.appendChild(s)}statuses.hidden=!snapshot.ui.statuses.length;
   for(const placement of ['aboveEditor','belowEditor']){const host=q(placement==='aboveEditor'?'#ac-pi-widgets-above':'#ac-pi-widgets-below');host.replaceChildren();const widgets=snapshot.ui.widgets.filter(w=>w.placement===placement);for(const widget of widgets){const p=document.createElement('pre');p.className='ac-pi-widget';p.textContent=widget.lines.join('\n');host.appendChild(p)}host.hidden=!widgets.length;}
  }
  if(snapshot.ui.editorText&&snapshot.ui.editorText!==piDraftSeen){piDraftSeen=snapshot.ui.editorText;piDraftOffer=snapshot.ui.editorText;q('#ac-pi-draft-offer').hidden=false;}
  if(!snapshot.connected){q('#ac-pi-draft-offer').hidden=true;piDraftOffer='';piDraftSeen='';}
  const notice=q('#ast-section-connections .ast-connection-notice p');if(notice)notice.textContent=snapshot.connected?snapshot.connectionLabel+' · Manage installed resources in Settings → Tools & plugins.':'This preview is not connected to an execution engine.';
  if(nativeSessionTransition?.created&&!lifecyclePending&&currentId&&currentId!==nativeSessionTransition.previousId){
   const pending=nativeSessionTransition;
   if(pending.binding===piSession&&pending.epoch===piSessionEpoch){nativeSessionTransition=null;activateSession({sessionId:currentId,title:snapshot.session.sessionName||pending.title},pending.title);toast('The new conversation is confirmed. Check its model and reasoning settings before sending.');}
  }
  if(workspaceStore?.getState().sessionBound===false){q('#ac-pi-transcript').hidden=true;q('#ac-pi-session-status').textContent='Connect the model to this conversation';return;}
  if(snapshot.connected&&(!piEngaged||!state.busy&&(snapshot.historyRevision||0)>piHistoryAfterSettle)){
   if(workspaceStore?.getState().sessionBound===false){q('#ac-pi-transcript').hidden=true;q('#ac-pi-session-status').textContent='Connect the model to this conversation';return;}
   const history=JSON.stringify(snapshot.messages);
   if(history!==piHistorySignature){piHistorySignature=history;piView.history(snapshot.messages);workspaceChrome?.refresh();if(piEngaged){piEngaged=false;piRunId=null;q('#ac-live-reply').hidden=true;}}
  }
 }
 function receivePiEvent(event){
  if(appDestroyed)return;
  if(event.type==='host_session_changed'||event.type==='session_changed'){
   piTurnEpoch++;preservePendingSubmission('The host changed conversations before acceptance.');resetPiActivity();piManualTools.clear();piManualView?.reset();q('#ac-live-user').hidden=true;piView?.clear?.();piHistorySignature='';piSessionIdentity='';return;
  }
  if(workspaceStore?.getState().sessionBound===false)return;
  if(event.type==='manuscript_draft'){researchFlow?.receiveDraft(event);return;}
  if(event.type==='host_command_start'){
   const presentation=window.AthenaPiActivity.toolPresentation('bash',event.args,'queued');
   piManualTools.set(event.id,{...presentation,id:'manual:'+event.id,toolCallId:event.id,toolName:'bash',args:event.args,status:'queued',output:'',outputRevision:0,startedAt:Date.now()});
   while(piManualTools.size>30)piManualTools.delete(piManualTools.keys().next().value);
   piManualView.render({tools:[...piManualTools.values()]});for(const tool of piManualTools.values())workspaceStore?.observeManual?.(tool);return;
  }
  if(event.type==='host_command_end'||(event.type==='bash_execution_update'&&piManualTools.has(event.id))){
   const tool=piManualTools.get(event.id);if(!tool)return;
   if(event.type==='bash_execution_update'){const delta=String(event.delta||'');tool.outputCharacters=(tool.outputCharacters||0)+delta.length;tool.output=(tool.output+delta).slice(-65536);tool.outputPreviewCharacters=tool.output.length;tool.outputTruncated=tool.outputCharacters>tool.output.length;tool.status='running';}
   else{const result=event.data||{};tool.output=String(event.error||result.output||'');tool.outputCharacters=tool.output.length;tool.outputPreviewCharacters=tool.output.length;tool.outputTruncated=false;tool.status=event.error||result.exitCode!=null&&result.exitCode!==0?'failed':result.cancelled?'stopped':'succeeded';tool.endedAt=Date.now();tool.durationMs=tool.endedAt-tool.startedAt;}
   Object.assign(tool,window.AthenaPiActivity.toolPresentation('bash',tool.args,tool.status));tool.outputRevision++;
   piManualView.render({tools:[...piManualTools.values()]});for(const tool of piManualTools.values())workspaceStore?.observeManual?.(tool);return;
  }
  if(event.type==='host_error'){toast(String(event.error||'Pi reported an error.'));return;}
  const controlOnly=['compaction_start','compaction_end','auto_compaction_start','auto_compaction_end','extension_error'].includes(event.type)||String(event.type).startsWith('summarization_retry_');
  if(controlOnly&&!(piEngaged&&state.busy)&&!piRuntime?.getState().session.isStreaming)return;
  if(event.type==='agent_start'){acceptSubmittedContext();if(piActivity.getState().settled&&piActivity.getState().sequence)archiveLiveTurn();}
  piView.observe(event);
  if(event.type==='message_start'&&event.message?.role==='user')q('#ac-live-user').hidden=true;
  piActivity.receive(event);
 }
 function detachPiSession(){
  preservePendingSubmission('The model disconnected before accepting this message.');nativeSessionTransition=null;piSessionEpoch+=1;piTurnEpoch++;
  piSessionUnsubscribe?.();piSessionUnsubscribe=null;piSession=null;
  if(piEngaged&&!piPreviewActive){reply.stop();state.busy=false;composer.setBusy(false)}
  piRuntime?.detach();piEngaged=false;piRunId=null;piSessionIdentity='';return true;
 }
 function attachPiSession(session,options={}){
  if(appDestroyed)return false;
  if(!session||typeof session.subscribe!=='function')throw new TypeError('Pi session needs subscribe(listener).');
  detachPiSession();clearPiPreview();reply.stop();state.busy=false;composer.setBusy(false);piActivity.reset();piView.reset();
  piView?.clear?.();q('#ac-pi-transcript').hidden=true;piHistorySignature='';q('#ac-live-user').hidden=true;q('#ac-live-reply').hidden=true;piManualTools.clear();piManualView.reset();
  const epoch=++piSessionEpoch;
  const binding=piRuntime.attach(session,options);piSession=binding.session;piSessionUnsubscribe=binding.detach;
  const current=piSession;
  return ()=>piSession===current&&piSessionEpoch===epoch?detachPiSession():false;
 }
 function resetPiActivity(){clearPiPreview();piEngaged=false;piRunId=null;piText='';piActivity.reset();piView.reset();reply.stop();q('#ac-live-reply').hidden=true;state.busy=false;composer.setBusy(false);chatModelPicker?.sync()}
 function previewPiActivity(){
  if(state.busy||workspaceStore?.getState().mode==='runtime'){toast(workspaceStore?.getState().mode==='runtime'?'Disconnect the live workspace before previewing sample events.':'Wait for the current response to finish.');return false}
  resetPiActivity();piPreviewActive=true;
  q('#ac-live-user').textContent='Preview file operations and response generation.';q('#ac-live-user').hidden=false;
  const emit=event=>{if(piPreviewActive&&!appDestroyed)piActivity.receive(event)};
  const later=(delay,event)=>{const timer=setTimeout(()=>{piPreviewTimers.delete(timer);emit(event)},delay);piPreviewTimers.add(timer)};
  emit({type:'agent_start'});
  later(180,{type:'message_start',message:{role:'assistant',content:[]}});
  later(300,{type:'message_update',assistantMessageEvent:{type:'thinking_start',contentIndex:0}});
  later(1000,{type:'message_update',assistantMessageEvent:{type:'thinking_end',contentIndex:0,content:''}});
  const operations=[['ls',{path:'project/'},'Example: README.md, src/, notes/'],['find',{pattern:'*.md',path:'project/'},'Example: README.md and notes/research.md'],['read',{path:'README.md'},'Example document preview. No file was read.'],['grep',{pattern:'cutoff',path:'src/'},'Example match: src/filter.py'],['bash',{command:'python scripts/check_filter.py'},'Simulated terminal output. No command was executed.'],['powershell',{command:'Get-Content README.md'},'Simulated PowerShell output.'],['edit',{path:'notes/research.md',oldText:'Draft',newText:'Reviewed'},'Example edit. No file was changed.'],['write',{path:'reports/summary.md',content:'Example summary'},'Example write. No file was created.']];
  operations.forEach(([toolName,args,output],index)=>{
   const toolCallId='preview-tool-'+index,start=1150+index*570;
   later(start,{type:'message_update',assistantMessageEvent:{type:'toolcall_start',contentIndex:index+1,id:toolCallId,toolName}});
   later(start+100,{type:'tool_execution_start',toolCallId,toolName,args});
   later(start+420,{type:'tool_execution_end',toolCallId,toolName,result:{content:[{type:'text',text:output}]},isError:false});
  });
  const answer='The file review and command checks are complete in this UI preview. Each operation keeps its own icon, and the answer appears as new text arrives. No files were changed and no commands were run.';
  const chunks=answer.match(/\S+\s*|\s+/g)||[];
  later(5800,{type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:20}});
  chunks.forEach((delta,index)=>later(5900+index*65,{type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:20,delta}}));
  const end=6200+chunks.length*65;
  later(end,{type:'message_end',message:{role:'assistant',content:[{type:'text',text:answer}],stopReason:'stop'}});
  later(end+80,{type:'agent_end',messages:[],willRetry:false});
  later(end+150,{type:'agent_settled',aborted:false});
  const scroller=q('.ac-conversation-inner');scroller.scrollTop=scroller.scrollHeight;return true;
 }
 const taskList=window.AthenaTaskList.mount(q('#ac-task-list'),{onSelect(value){const id=typeof value==='string'?value:value?.id;if(id==='sensitivity'){q('#ac-task-detail-title').textContent='RC sensitivity analysis'}else if(id==='plan'){dialog('Approved research plan','<p>Compare the baseline RC response with theory, then evaluate how component values affect the cutoff frequency.</p><p>Approved scope: ngspice · Lab server · Up to 12 conditions · 1% tolerance</p>')}else if(id==='report'){openPanel('manuscript',null,document.activeElement)}else if(id==='verify'||id==='baseline'){openPanel('results',id==='verify'?'table':'response',document.activeElement)}}});
 const command=window.AthenaControls.command(q('#ac-command-slot'),{onSearch:search});const tooltips=window.AthenaControls.tooltip(root);
 function reconcile(){
  if(reconcileTimer)return;
  q('#ac-reconcile').disabled=true;
  q('#ac-reconcile').textContent='Checking existing run…';
  reconcileTimer=setTimeout(()=>{
   reconcileTimer=0;
   // Local preview states only. No simulator, host, or queue is contacted.
   const finished=state.taskState==='running'||state.taskState==='done';
   state.taskState=finished?'done':'running';
   taskList.setTaskState('sensitivity',state.taskState);
   q('#ac-recovery-title').textContent=finished?'Run complete · Review required':'Reconnected to existing run';
   q('#ac-recovery-description').textContent=finished?'All 12 conditions are complete. Review the values and assumptions before updating the manuscript.':'8 of 12 conditions are complete. The remaining conditions continue in the existing run.';
   q('#ac-recovery').style.background='#f0f3eb';
   q('#ac-recovery').style.borderColor='#d7dfce';
   q('#ac-last-checked').textContent=(finished?'12 / 12':'8 / 12')+' conditions · Just checked';
   if(q('#ac-inline-task-state'))q('#ac-inline-task-state').textContent=finished?'Complete · 12 / 12 conditions · Review required':'Running · 8 / 12 conditions · Lab server';
   q('#ac-task-count').textContent=finished?'4 / 5 complete':'3 complete · 1 running';
   q('#ac-reconcile').disabled=false;
   q('#ac-reconcile').innerHTML='<i data-lucide="refresh-cw" aria-hidden="true"></i>Check status';
   icons();
   toast(finished?'Preview: the existing run is complete.':'Preview: the existing run was checked. No new calculation was submitted.');
  },800);
 }
 listen(root,'click',e=>{const b=e.target.closest('button');if(!b||!root.contains(b)||b.disabled)return;if(b.dataset.openSession){openResearchSession(b.dataset.openSession);return;}if(b.dataset.open){if(b.hasAttribute('data-search-result'))closeDialog();openPanel(b.dataset.open,b.dataset.artifact||null,b);return}if(b.dataset.panelTab){if(b.dataset.panelTab==='workflow')openWorkspace('workflow',null,b);else panelTab(b.dataset.panelTab);return}if(b.dataset.workspaceView){openWorkspace(b.dataset.workspaceView,null,b);return}if(b.dataset.workspaceArtifact){openWorkspace('artifacts',{artifactId:b.dataset.workspaceArtifact},b);return}const action=b.dataset.action;if(!action)return;
  if(action==='toggle-panel'){if(state.panelOpen)closePanel(false);else{const view=settings?.getState().defaultSideView||'home';view==='research'?openPanel(state.panelTab,null,b):openSurface(view,b)}return}if(action==='surface-home'){openSurface('home',b);return}if(action==='toggle-left'){toggleLeft();return}if(action==='open-file'){openSurface('files',b);surfaces?.openFile?.(b.dataset.file);return}if(action==='close-dialog'){closeDialog();return}if(action==='reconcile'){reconcile();return}
  if(action==='open-claim'){openPanel('results','response',b);return}
  if(action==='edit-manuscript'){
   const doc=records.getDocument(activeDocumentId);if(!doc||doc.selectedVersion!==doc.currentVersion){toast('Select the latest document version to edit.');return;}
   state.documentEditing=!state.documentEditing;q('#ac-document-editor').hidden=!state.documentEditing;q('#ac-editor-label').hidden=!state.documentEditing;q('#ac-document').hidden=state.documentEditing;
   b.innerHTML=state.documentEditing?'<i data-lucide="check" aria-hidden="true"></i>Done':'<i data-lucide="pencil" aria-hidden="true"></i>Edit';
   if(state.documentEditing)q('#ac-document-editor').focus({preventScroll:true});else records.updateDraft(activeDocumentId,q('#ac-document-editor').value);
   renderDocumentRecord();icons();return;
  }
  if(action==='export-manuscript'){
   const doc=records.getDocument(activeDocumentId);if(!doc)return;
   const value=doc.selectedVersion===doc.currentVersion&&doc.draft.dirty?doc.draft.text:doc.versions.find(item=>item.version===doc.selectedVersion).text;
   const url=URL.createObjectURL(new Blob([value],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=doc.documentId+'-'+(doc.draft.dirty?'draft':'v'+doc.selectedVersion)+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }
  if(action==='open-agents'){openWorkspace('timeline',null,b);return}
  if(action==='pi-queue'){openPi('queue');return}
  if(action==='pi-resources'){openPi('resources');return}
  if(action==='pi-send-queued'){sendQueuedDraft();return}
  if(action==='pi-use-draft'){usePiDraft(piDraftOffer);return}
  if(action==='programs'){openSettings('connections');return}
  if(action==='settings'){openSettings('general');return}
  if(action==='search'){dialog('Find resources','<p>Find circuits, results, tasks, and notes in this project.</p><input id="ac-search-input" aria-label="Search resources" placeholder="Try frequency response">','Search',()=>search(q('#ac-search-input').value));q('#ac-search-input').focus();return}
  if(action==='new-project'){requestProject();return;}
  if(action==='new-research'){requestResearch();return;}
  if(action==='current-draft'){closeDialog();composer.focus();return;}
  if(action==='restore-unsent'){
   const failed=failedDrafts.shift();if(!failed)return;const current=composer.captureDraft();
   composer.restoreDraft({value:failed.value+(current.value?'\n\n'+current.value:''),attachments:[...failed.attachments,...current.attachments],mentions:[...failed.mentions,...current.mentions]});
   q('#ac-unsent-draft').hidden=!failedDrafts.length;q('#ac-unsent-draft span').textContent=failedDrafts.length+' unsent messages remain.';return;
  }
  if(action==='notes'){openPanel('manuscript',null,b);return}if(action==='copy-response'){const text=q('.ac-response').innerText;if(navigator.clipboard?.writeText)navigator.clipboard.writeText(text).then(()=>toast('Response copied.')).catch(()=>toast('Clipboard access is unavailable in this environment.'));else toast('Clipboard access is unavailable in this environment.');return}
  if(action==='current-thread'){return}
  const descriptions={'sample-thread':'The RC filter validation conversation is available in this preview.'};if(descriptions[action])dialog(b.textContent.trim(),'<p>'+descriptions[action]+'</p>');
 });
 listen(q('#ac-dialog-primary'),'click',()=>dialogAction?.());listen(q('#ac-artifact-select'),'change',e=>setArtifact(e.target.value));listen(q('#ac-document-editor'),'input',()=>{if(records?.getDocument(activeDocumentId))records.updateDraft(activeDocumentId,q('#ac-document-editor').value)});listen(q('#ac-overlay-scrim'),'click',()=>{if(!state.leftDrawer)closePanel()});listen(q('#ac-dialog-backdrop'),'click',e=>{if(e.target===q('#ac-dialog-backdrop'))closeDialog()});
 listen(root,'keydown',e=>{if(e.defaultPrevented||e.isComposing)return;
  if((e.metaKey||e.ctrlKey)&&e.key===','){e.preventDefault();openSettings();return}
  if(settings?.isOpen()||workspaceChrome?.isApprovalOpen()||piWorkbench?.isDialogOpen())return;
  const selectedTab=e.target.closest('.ac-panel-tab[role="tab"]');
  if(selectedTab&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
   const tabs=qa('.ac-panel-tab');const i=tabs.indexOf(selectedTab);const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
   e.preventDefault();panelTab(tabs[next].dataset.panelTab);tabs[next].focus();return;
  }
const dialogOpen=!q('#ac-dialog-backdrop').hidden;const rightOverlay=state.panelOpen&&root.dataset.panelLayout==='overlay';if(e.key==='Escape'){if(dialogOpen)closeDialog();else if(state.leftDrawer){toggleLeft()}else if(state.panelOpen&&(rightOverlay||q('#ac-research-panel').contains(document.activeElement)))closePanel();return}if(e.key==='Tab'&&(dialogOpen||state.leftDrawer)){const container=dialogOpen?q('.ac-dialog'):state.leftDrawer?q('#ac-sidebar'):q('#ac-research-panel');const items=[...container.querySelectorAll('button:not([disabled]),input:not([hidden]),select,textarea,summary,[tabindex="0"]')].filter(el=>!el.closest('[hidden]')&&el.getClientRects().length);if(!items.length)return;const first=items[0],last=items[items.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});
 const resize=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>{syncLeftUI();layout?.refresh();overlay();drawChart()}):null;resize?.observe(root);
 piActivity=window.AthenaPiActivity.create();
 piRuntime=window.AthenaPiRuntime.create();
 piView=window.AthenaConversationStream.mount(q('#ac-pi-transcript'),{icons,toast,onBeforeLayout:beforeConversationLayout,onAfterLayout:afterConversationLayout,getWorkspace:()=>workspaceStore?.getState(),getActivityFallback:()=>q('#aw-activity')});
 piManualView=window.AthenaPiSessionView.mount(q('#ac-pi-manual-activity'),{icons,toast,getWorkspace:()=>workspaceStore?.getState()});
 piSubscription=piActivity.subscribe(renderPiActivity);
 piEventSubscription=piRuntime.subscribeEvents(receivePiEvent);
 demoStore=window.AthenaWorkspaceStore.create();
 workspaceStore=window.AthenaWorkspaceSession.create({demo:demoStore,runtime:piRuntime,onError:toast,hosted});
 connectionManager=window.AthenaConnectionManager.create();
 records=window.AthenaResearchRecords.create({projectId:'project-rc',onError:error=>toast(String(error.message||error))});
 if(!hosted)records.ensureDocument({documentId:'research-note',title:'RC low-pass filter: frequency response validation',text:note,version:'1',originalSample:true,evidence:[{sourceId:'baseline.cir',version:'1'}]});
 surfaces=window.AthenaSurfaces.mount(q('#ac-surface-slot'),{files,icons,toast,onResearch:tab=>openPanel(tab||'results'),onWorkspace:(view,selection)=>openWorkspace(view,selection),onAgents:()=>openWorkspace('timeline'),onClose:()=>closePanel()});
 workspaceViews=window.AthenaWorkspaceViews.mount(q('#ac-workbench-slot'),{store:workspaceStore,records,icons,toast,onNavigate:(view,selection)=>openWorkspace(view,selection),onApproval:openApproval});
 knowledge=window.AthenaKnowledge.mount(q('#ac-knowledge-slot'),{icons,toast,hosted,onUseSource(item){
  const snippet='['+item.title+']'+(item.metadata?.persistence==='host'?' · sourceId '+item.id+' · version '+item.metadata.sourceVersion:'')+'\n'+String(item.excerpt||'');
  composer.setValue((composer.getValue().trim()?composer.getValue()+'\n\n':'')+snippet);
  closePanel(false);if(!q('#ac-conversation').inert)composer.focus();
  toast(item.title+' excerpt added to the draft.');
 },onOpenArtifact:id=>openWorkspace('artifacts',{artifactId:id})});
 workspaceChrome=window.AthenaWorkspaceChrome.mount(root,{store:workspaceStore,onBeforeLayout:beforeConversationLayout,onAfterLayout:afterConversationLayout,placeActivity:(node,details)=>piView.placeActivity(node,details),removeActivity:id=>piView.removeActivity(id),hasConversationTool:id=>piView.hasTool(id),icons,toast,onPreviewReply:previewPiActivity,onNavigate:(view,selection)=>openWorkspace(view,selection),onModalChange(){overlay()}});
 syncLeftUI();
 layout=window.AthenaResize.mount(root,{onResize(){overlay();drawChart()}});
 settings=window.AthenaSettings.mount(root,{
  icons,toast,
  getSidebarOpen:()=>state.leftOpen,
  onSidebarChange:open=>setLeftOpen(open),
  onResetLayout:()=>layout?.reset(),
  getDemoMode:()=>workspaceStore.getState().mode==='demo',onDemoModeChange:enabled=>workspaceStore.setDevelopment(enabled),isRuntimeConnected:()=>workspaceStore.getState().mode==='runtime',onRuntimeSection:section=>piWorkbench?.open(section),
  onChange(preferences){composer.setSendKey?.(preferences.sendKey);drawChart()},
  onOpen(){overlay();extensions?.refresh();announce('Settings opened.')},
  onClose(){overlay();announce('Settings closed.')}
 });
 extensions=window.AthenaExtensions?.mount(q('#ast-extensions-slot'),{icons,getWorkspace:()=>workspaceStore.getState(),onSkillsChange:skills=>composer.setProjectSkills?.(skills),onUseSkill(skill){
  const request=skill.roles?.includes('parent')?'$'+skill.id+' ':'Use the "'+skill.name+'" skill ('+skill.id+') for this task.';
  composer.setValue((composer.getValue().trim()?composer.getValue()+'\n\n':'')+request);
  settings?.close(false);overlay();composer.focus();toast('Skill added to your draft. Send the request to use it.');
 }});
 modelSettings=window.AthenaModelSettings.mount(q('#ast-model-settings-slot'),{icons,toast,connectionManager,hosted,onSetProjectDefaultModel:value=>workspaceStore.setProjectDefaultModel(value),onSetProjectExecution:(id,enabled)=>workspaceStore.setProjectExecution(id,enabled),onChange(config){
  chatModelPicker?.setPreferences(config);
  workspaceStore.configure?.({parallelLimit:config.parallelLimit});
 }});
 providerProfiles=window.AthenaProviderProfiles.mount(q('#ast-provider-profiles-slot'),{icons,toast,hosted,getWorkspace:()=>workspaceStore.getState()});
 const modelConfig=modelSettings.getState().saved;
 chatModelPicker=window.AthenaChatModelPicker.mount(q('#ac-model-picker-slot'),{runtime:piRuntime,preferences:modelConfig,icons,announce,isBusy:()=>state.busy||piSubmitting||lifecyclePending||Boolean(nativeSessionTransition),isSessionBound:()=>workspaceStore.getState().sessionBound!==false,isUnavailable:()=>q('#ac-conversation').inert,beforeOpen(){composer.closeMenu?.();command?.close?.(false)},onOpenSettings(){piSession?openPi('model'):openSettings('models')}});
 workspaceStore.configure?.({parallelLimit:modelConfig.parallelLimit});
 piWorkbench=window.AthenaPiWorkbench.mount(q('#ast-pi-workbench-slot'),{runtime:piRuntime,icons,toast,onDraft:usePiDraft,onSectionChange:section=>settings?.routeRuntime(section),onModalChange(){overlay()}});
 researchFlow=window.AthenaResearchFlow?.mount(q('#ac-research-flow'),{open:openWorkspace,editor:async id=>{q('#ac-view-manuscript').dataset.editorOpen='true';await paperPanel?.select(id);q('#ac-paper-project').scrollIntoView({block:'start'});},stage:text=>{currentResearchStage=text;const e=q('#ac-flow-stage');if(e)e.textContent=text;}});
 paperPanel=window.AthenaManuscripts?.mount(q('#ac-paper-project'),{open:(documentId,version)=>openDocument({documentId,version}),cancel:id=>workspaceStore.cancel(id)});
 mountDocumentToolbar();
 recordsOff=records.subscribe(renderDocumentRecord);
 workspaceOff=workspaceStore.subscribe(renderWorkspace);
 connectionOff=connectionManager.subscribe(()=>workspaceStore.setAppDefault(connectionManager.getDefaultModel()));
 piRuntimeSubscription=piRuntime.subscribe(renderPiShell);
 composer.setSendKey?.(settings.getState().sendKey);
 root.dispatchEvent(new CustomEvent('ac:settings-change',{detail:{settings:settings.getState(),key:'restore'}}));
 icons();panelTab('results');setArtifact('response');overlay();
 window.AthenaApp={
  openPanel:(tab,artifact)=>openPanel(tab,artifact),openSurface:(id)=>openSurface(id),openWorkspace:(view,selection)=>openWorkspace(view,selection),closePanel:()=>closePanel(),openAgents:(id)=>openAgents(id),
  openApproval,startDemo:()=>workspaceStore.start(),pauseDemo:()=>workspaceStore.pause(),resumeDemo:()=>workspaceStore.resume(),cancelDemo:()=>workspaceStore.cancel(),retryTask:id=>workspaceStore.retryTask(id),resetDemo:()=>workspaceStore.reset(),setScenario:scenario=>workspaceStore.setScenario(scenario),
  handlePiEvent,attachPiSession,attachPiTransport:(transport,options={})=>attachPiSession(transport,{...options,mode:options.mode||transport.mode||'rpc'}),detachPiSession,resetPiActivity,previewPiActivity,
  attachTaskManager:adapter=>workspaceStore.attach(adapter),detachTaskManager:()=>workspaceStore.detach(),
  enterHostedMode:()=>workspaceStore.enterHostedMode(),
  reportHostError:message=>toast(String(message)),
  attachConnectionManager:adapter=>connectionManager.attach(adapter),detachConnectionManager:()=>connectionManager.detach(),
  attachPaperService:service=>{researchFlow?.attach(service);researchFlow?.scope(workspaceStore.getState());paperPanel?.attach(service);paperPanel?.scope(workspaceStore.getState());},
  attachResearchService:adapter=>{records.attach(adapter.documents||adapter);knowledge.attachRecords(adapter.knowledge||adapter);return true;},detachResearchService:()=>{records.detach();knowledge.detachRecords();},
  loadDocument:(id,version)=>openDocument({documentId:id,version}),ensureDocument:document=>records.ensureDocument(document),
  createProject:input=>workspaceStore.createProject(input),createResearch,openResearchSession,setDemoMode:enabled=>workspaceStore.setDevelopment(enabled),
  openPi,executePi:(action,params)=>piRuntime.execute(action,params),refreshPi:()=>piRuntime.refresh(),respondPiUI:(id,response)=>piRuntime.respondUI(id,response),
  attachModelProfiles:adapter=>{modelProfilesAdapter=adapter||null;providerProfiles?.setModelProfiles(adapter);chatModelPicker?.setModelProfiles(adapter);if(adapter)renderWorkspace(workspaceStore.getState());},
  attachWebAddressOpener:opener=>surfaces.setWebAddressOpener(opener),
  attachExtensions:adapter=>{extensionService=adapter||null;extensions?.setService(extensionService);extensions?.setWorkspace();workspaceViews?.setResearchService(extensionService);},
  openSettings,closeSettings:()=>settings?.close(),openModelPicker:(kind='model')=>chatModelPicker?.open(kind),
  getState:()=>({...state,piActivity:piActivity?.getState(),reply:reply.getState(),piConnected:Boolean(piSession),piRuntime:piRuntime?.getState(),piWorkbench:piWorkbench?.getState(),modelPicker:chatModelPicker?.getState(),workspace:workspaceStore?.getState(),workspaceView:workspaceViews?.getState(),knowledge:knowledge?.getState(),records:records?.getState(),connections:connectionManager?.getState(),models:modelSettings?.getState(),extensions:extensions?.getState(),approval:workspaceChrome?.getState(),settings:settings?.getState(),settingsOpen:Boolean(settings?.isOpen()),surface:surfaces?.getState(),layout:layout?.getState(),document:q('#ac-document-editor').value,prompt:composer.getValue()}),submit,search,
  destroy(){appDestroyed=true;clearPiPreview();piSessionUnsubscribe?.();piSubscription?.();piRuntimeSubscription?.();piEventSubscription?.();workspaceOff?.();connectionOff?.();recordsOff?.();recordToolbar?.destroy();paperPanel?.destroy();researchFlow?.destroy();records?.destroy();connectionManager?.destroy();chatModelPicker?.destroy();piWorkbench?.destroy();piRuntime?.destroy();piManualView?.destroy();piManualTools.clear();piView?.destroy();piActivity?.destroy();workspaceChrome?.destroy();workspaceViews?.destroy();knowledge?.destroy();modelSettings?.destroy();providerProfiles?.destroy();extensions?.destroy();workspaceStore?.destroy();demoStore?.destroy();settings?.destroy();controller.abort();resize?.disconnect();layout?.destroy();surfaces?.destroy();clearTimeout(toastTimer);clearTimeout(reconcileTimer);composer.destroy();reply.destroy();taskList.destroy();command?.destroy();tooltips.destroy()}
 };
 window.dispatchEvent(new CustomEvent('athena:ready'));
})();
