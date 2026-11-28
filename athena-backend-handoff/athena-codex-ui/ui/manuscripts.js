// The host owns project documents, source versions, progress and exports.
window.AthenaManuscripts = {mount(root, options) {
  const controller=new AbortController(), listeners={signal:controller.signal};
  const q = name => root.querySelector('[data-paper="'+name+'"]');
  let service, project, session, selected='', generation=0, detailGeneration=0, detail, timer, dirtyOutline=false;
  let searchRows=[], searchId='', historyRequest=0, historyTimer;
  let catalog={documents:[],sources:[]}, snapshot, starting=false;
  function option(value,label){const el=document.createElement('option');el.value=value;el.textContent=label;return el;}
  function choices(el,items,placeholder){
    const previous=el.value;
    el.replaceChildren(option('',placeholder),...items.map(([id,title])=>option(id,title)));
    if(items.some(([id])=>id===previous))el.value=previous;
  }
  function call(method,args={}){return service(method,{projectId:project,...args});}
  function searchCall(method,args={}){return call(method,{sessionId:session,...args});}
  function renderSearch(){
    const row=searchRows.find(r=>r.id===searchId);
    q('candidates').replaceChildren();q('search-status').textContent=row?[
      row.status,row.error,row.retrievedAt&&'Retrieved '+row.retrievedAt,row.status==='authorized'&&'Share this search ID in chat: '+row.id,
      row.status==='succeeded'&&!row.records.length&&'No matching works'].filter(Boolean).join(' · '):'';
    root.querySelector('[data-paper-action="cancel-search"]').disabled=!['running','authorized'].includes(row?.status);
    for(const item of row?.records||[]){
      const line=document.createElement('p'),button=document.createElement('button');
      line.textContent=item.title+' · '+item.doi+' · '+item.level+' ';
      button.textContent='Add source';button.dataset.paperAction='add-candidate';button.dataset.doi=item.doi;
      line.append(button);q('candidates').append(line);
    }
  }
  async function history(prefer){
    const epoch=generation,request=++historyRequest,rows=await searchCall('bibliographyHistory');
    if(epoch!==generation||request!==historyRequest)return;
    clearTimeout(historyTimer);
    if(rows.some(r=>r.status==='running'||r.status==='authorized'))historyTimer=setTimeout(()=>history().catch(notice),3000);
    searchRows=rows;searchId=prefer||searchId||rows[0]?.id||'';
    choices(q('history'),rows.map(r=>[r.id,r.term+' · '+r.status]),'Select a search');q('history').value=searchId;renderSearch();
  }
  function notice(error){q('notice').textContent=String(error?.message||error);}
  async function refresh(){
    if(!service||!project)return;
    const epoch=generation, next=await call('listPapers'); if(epoch!==generation)return;
    catalog=next;
    choices(q('documents'),catalog.documents.map(d=>[d.id,d.title]),'Select a manuscript');
    q('documents').value=selected;
    const checked=new Set(Array.from(q('sources').options).filter(o=>o.selected).map(o=>o.value));
    q('sources').replaceChildren(...catalog.sources.map(s=>option(s.sourceId,s.title+' · '+s.level)));
    for(const o of q('sources').options)o.selected=checked.has(o.value);
  }
  async function assessment(){
    const version=q('versions').value,id=selected,epoch=generation;
    if(!version){q('assessment').textContent='';return;}
    const v=await call('getDocument',{documentId:id,version});
    if(epoch!==generation||id!==selected||q('versions').value!==version)return;
    q('assessment').textContent=[v.assessment?.verdict||'Unreviewed',...(v.issues||[]),...(v.assessment?.findings||[])].join(' · ');
  }
  async function details(preferredVersion){
    clearTimeout(timer);if(!selected)return;
    const token=++detailGeneration,epoch=generation,d=await call('paperDetails',{documentId:selected});
    if(epoch!==generation||token!==detailGeneration||d.id!==selected)return;
    detail=d;q('goal-display').textContent=d.goal;
    if(!dirtyOutline&&document.activeElement!==q('outline'))q('outline').value=d.outline.join('\n');
    const versions=d.versions.map((v,i)=>[v,'Revision '+(i+1)]);
    if(JSON.stringify(versions)!==q('versions').dataset.signature){
      const previous=q('versions').dataset.signature&&q('versions').value;
      choices(q('versions'),versions,'Select a revision');q('versions').value=previous&&d.versions.includes(previous)?previous:d.versions.at(-1)||'';
      q('versions').dataset.signature=JSON.stringify(versions);
    }
    if(preferredVersion!==undefined)q('versions').value=d.versions.includes(preferredVersion)?preferredVersion:'';
    const r=d.runs.at(-1);
    q('progress').textContent=r?[r.stage+' · '+r.executionStatus,...r.sections.map(s=>'Draft saved · '+s.heading),
      ...r.reviews.flatMap(v=>[v.verdict,...v.checks,...v.findings]),r.error].filter(Boolean).join('\n'):'Ready';
    const live=r&&['queued','running','blocked'].includes(r.executionStatus);
    q('cancel').disabled=!live;q('write').disabled=live||!d.outline.length;q('plan').disabled=!!live;
    await assessment();if(epoch!==generation||token!==detailGeneration)return;
    if(live)timer=setTimeout(()=>details().catch(notice),1000);
  }
  function reset(){
    generation++;detailGeneration++;clearTimeout(timer);clearTimeout(historyTimer);selected='';detail=null;dirtyOutline=false;
    root.querySelectorAll('input,textarea').forEach(el=>{el.value='';});q('existing').hidden=true;
    q('progress').textContent='';q('notice').textContent='';q('versions').dataset.signature='';
    q('documents').replaceChildren();q('sources').replaceChildren();
    root.hidden=!project||!service;searchId='';searchRows=[];q('history').replaceChildren();renderSearch();
    if(!root.hidden){refresh().catch(notice);history().catch(notice);}
  }
  async function choose(id){
    selected=id;detail=null;dirtyOutline=false;detailGeneration++;q('existing').hidden=!id;q('versions').dataset.signature='';
    await details();
    if(id===selected&&detail?.versions.length)await options.open(id,detail.versions.at(-1));
  }
  root.addEventListener('change',e=>{
    if(e.target===q('history')){searchId=e.target.value;renderSearch();}
    if(e.target===q('documents'))choose(e.target.value).catch(notice);
    if(e.target===q('versions')&&e.target.value){assessment().catch(notice);options.open(selected,e.target.value);}
  },listeners);
  q('outline').addEventListener('input',()=>{dirtyOutline=true;},listeners);
  root.addEventListener('click',async e=>{
    const button=e.target.closest('[data-paper-action]');if(!button||button.disabled||!service)return;
    const action=button.dataset.paperAction, epoch=generation,id=selected;
    button.disabled=true;
    try {
      if(action==='search'||action==='authorize'){
        const mode=q('search-mode').value;
        const row=await searchCall('authorizeSearch',{term:q('term').value,mode,pages:mode==='query'?2:1,requestId:crypto.randomUUID()});
        if(epoch!==generation)return;
        await history(row.id);if(epoch!==generation||action==='authorize')return;
        q('search-status').textContent='Searching Crossref…';
        await searchCall('executeSearch',{searchId:row.id});if(epoch===generation)await history();return;
      } else if(action==='cancel-search'){await searchCall('cancelSearch',{searchId});if(epoch===generation)await history();return;}
      else if(action==='add-candidate'){await searchCall('addSearchSource',{searchId,doi:button.dataset.doi});}
      else if(action==='add-file'){
        const file=q('file').files[0];if(!file||file.size>240000)throw Error('Choose a UTF-8 text file up to 240 KB.');
        const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());if(epoch!==generation)return;
        await call('addPaperSource',{title:file.name,text});
      } else if(action==='add-result'){await call('addPaperSource',{artifactId:q('artifacts').value});}
      else if(action==='create'){
        const ids=Array.from(q('sources').options).filter(o=>o.selected).map(o=>o.value);
        const evidence=catalog.sources.filter(s=>ids.includes(s.sourceId)).map(({sourceId,version})=>({sourceId,version}));
        const d=await call('createPaper',{title:q('title').value,goal:q('goal').value,evidence});
        if(epoch!==generation)return;await choose(d.id);
      } else if(action==='save-outline'){
        await call('setPaperOutline',{documentId:id,outline:q('outline').value.split('\n').filter(s=>s.trim())});dirtyOutline=false;
      } else if(action==='write'||action==='plan'){
        if(starting)return;if(dirtyOutline)throw Error('Save the edited outline first.');
        starting=true;
        try {await call('startPaper',{sessionId:session,documentId:id,requestId:crypto.randomUUID(),mode:action==='plan'?'outline':'write'});}
        finally{starting=false;}
      } else if(action==='cancel'){await options.cancel(detail.runs.at(-1).id);}
      else if(action==='preview'){if(q('versions').value)await options.open(id,q('versions').value);}
      else if(action==='md'||action==='json'){
        const version=q('versions').value;if(!version)throw Error('Select a stored revision first.');
        const receipt=await call('exportPaper',{documentId:id,version,format:action});if(epoch!==generation||selected!==id)return;
        const a=document.createElement('a');a.href=receipt.uri;a.download=receipt.name;a.click();
      }
      if(generation!==epoch)return;await refresh();if(generation===epoch)await details();
    } catch(error){if(epoch===generation)notice(error);}
    finally{button.disabled=false;if(epoch===generation&&selected)details().catch(notice);}
  },listeners);
  return {async select(id){await refresh();await choose(id);},attach(value){service=value;reset();},refresh,reload(version){details(version).catch(notice);},scope(s){
    snapshot=s;
    if(project!==s.projectId||session!==s.sessionId){project=s.projectId;session=s.sessionId;reset();}
    const items=(snapshot.artifacts||[]).filter(a=>a.status==='ready').map(a=>[a.id,a.title]);
    const signature=JSON.stringify(items);if(q('artifacts').dataset.signature!==signature){
      choices(q('artifacts'),items,'Select a saved result');q('artifacts').dataset.signature=signature;
    }
  },destroy(){controller.abort();generation++;clearTimeout(timer);clearTimeout(historyTimer);}};
}};
