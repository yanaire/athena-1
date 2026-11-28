// Traverse project membership and the exact source editions assigned to a manuscript.
window.AthenaProjectGraph={create({load,openPaper}){
  const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const button=(label,action)=>{const b=el('button',label);b.type='button';b.onclick=action;return b;};
  const element=el('details'),body=el('section');
  element.dataset.disclosure='project-library';element.className='ac-project-graph';
  element.append(el('summary','Project knowledge graph'),body);
  let catalog=null,focus=null,generation=0,loading=false;

  const editionKey=ref=>JSON.stringify([ref.sourceId,ref.version]);
  const pinned=(paper,source)=>paper.evidence?.some(ref=>ref.sourceId===source.sourceId && ref.version===source.version);
  function overview(documents,sources){
    const overview=el('div');overview.className='ac-knowledge-map';
    const byEdition=new Map(sources.map(source=>[editionKey(source),source]));
    const linkedSources=new Map(),linkedPapers=[],connections=[];
    for(const paper of documents){
      const assigned=new Set((paper.evidence??[]).map(editionKey).filter(key=>byEdition.has(key)));
      if(!assigned.size)continue;
      const paperIndex=linkedPapers.push(paper)-1;
      for(const key of assigned){
        if(!linkedSources.has(key))linkedSources.set(key,[]);
        linkedSources.get(key).push(paperIndex);
        connections.push({paper,key});
      }
    }
    const makeNode=(record,source,labels)=>{
      const ref=source?{kind:'source',id:record.sourceId,version:record.version}:{kind:'paper',id:record.id};
      const node=button(record.title,()=>select(ref));
      node.className='ac-map-node '+(source?'ac-map-source':'ac-map-paper');
      node.dataset.kind=ref.kind;node.dataset.id=ref.id;
      if(source)node.dataset.version=ref.version;
      const description=labels.length?'Linked to '+labels.join(', '):'No linked '+(source?'manuscripts':'sources');
      node.title=record.title+' — '+description+(source?' · '+record.version:'');
      node.setAttribute('aria-description',description);
      return node;
    };
    const header=el('div');header.className='ac-map-heading';
    header.append(el('small','Manuscripts'),el('small','Source editions'));overview.append(header);
    if(connections.length){
      // Center sparse columns and order source editions by the positions of
      // their actual manuscripts so shared references converge on one node.
      const average=indices=>indices.reduce((total,i)=>total+i,0)/indices.length;
      const editions=[...linkedSources.keys()].sort((a,b)=>average(linkedSources.get(a))-average(linkedSources.get(b)));
      const network=el('div');network.className='ac-map-network';
      network.setAttribute('role','group');network.setAttribute('aria-label','Manuscripts and their assigned source editions');
      const rows=Math.max(linkedPapers.length,editions.length);
      network.style.height=(rows*64)+'px';
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('class','ac-map-links');svg.setAttribute('viewBox','0 0 100 '+rows*64);
      svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');
      network.append(svg);
      const positions=new Map();
      function place(record,index,length,source,labels){
        const center=(index+0.5)/length;
        const node=makeNode(record,source,labels);node.style.top=(center*100)+'%';
        network.append(node);positions.set(record,{y:center*rows*64,node});
      }
      for(const [i,paper] of linkedPapers.entries())
        place(paper,i,linkedPapers.length,false,connections.filter(link=>link.paper===paper).map(link=>byEdition.get(link.key).title));
      for(const [i,key] of editions.entries())
        place(byEdition.get(key),i,editions.length,true,linkedSources.get(key).map(n=>linkedPapers[n].title));

      const neighbors=new Map();
      for(const {paper,key} of connections){
        const from=positions.get(paper),to=positions.get(byEdition.get(key));
        const path=document.createElementNS('http://www.w3.org/2000/svg','path');
        path.setAttribute('d','M 0 '+from.y+' C 48 '+from.y+' 52 '+to.y+' 100 '+to.y);
        path.setAttribute('vector-effect','non-scaling-stroke');
        path.dataset.paperId=paper.id;path.dataset.sourceId=byEdition.get(key).sourceId;
        path.dataset.version=byEdition.get(key).version;svg.append(path);
        for(const [node,other] of [[from.node,to.node],[to.node,from.node]]){
          if(!neighbors.has(node))neighbors.set(node,[]);
          neighbors.get(node).push({path,other});
        }
      }
      const emphasize=node=>{
        for(const path of svg.children)path.classList.remove('ac-map-related');
        for(const button of neighbors.keys())button.classList.remove('ac-map-related');
        network.classList.toggle('ac-map-tracing',!!node);
        if(node){
          node.classList.add('ac-map-related');
          for(const {path,other} of neighbors.get(node)){path.classList.add('ac-map-related');other.classList.add('ac-map-related');}
        }
      };
      for(const node of neighbors.keys()){
        node.onfocus=()=>emphasize(node);node.onblur=()=>emphasize(null);
        node.onmouseenter=()=>emphasize(node);node.onmouseleave=()=>emphasize(neighbors.has(document.activeElement)?document.activeElement:null);
      }
      overview.append(network);
    }
    const isolatedPapers=documents.filter(paper=>!linkedPapers.includes(paper));
    const isolatedSources=sources.filter(source=>!linkedSources.has(editionKey(source)));
    if(isolatedPapers.length||isolatedSources.length){
      const area=el('section');area.className='ac-map-isolated';
      area.setAttribute('aria-label','Unlinked records');area.append(el('small','Unlinked records'));
      const columns=el('div');columns.className='ac-map-columns';
      for(const [source,records] of [[false,isolatedPapers],[true,isolatedSources]]){
        const column=el('div');
        for(const record of records)column.append(makeNode(record,source,[]));
        columns.append(column);
      }
      area.append(columns);overview.append(area);
    }
    return overview;
  }

  function select(item){focus=item;draw();body.querySelector('h4')?.focus();}
  function draw(){
    const documents=catalog.documents,sources=catalog.sources;
    const record=focus?.kind==='paper'?documents.find(d=>d.id===focus.id):sources.find(s=>s.sourceId===focus?.id && s.version===focus?.version);
    if(!record)focus=null;
    const fragment=document.createDocumentFragment(),title=el('h4',record?.title||'Project library');
    title.tabIndex=-1;
    if(focus)fragment.append(button('← Project library',()=>select(null)));
    fragment.append(title);
    const children=(label,items)=>{
      if(!items.length)return;
      const branch=el('section'),list=el('ul');branch.className='ac-graph-branch';
      branch.append(el('small',label+' · '+items.length),list);
      for(const row of items){
        const li=el('li');
        li.append(button(row.title,()=>select(row.sourceId?{kind:'source',id:row.sourceId,version:row.version}:{kind:'paper',id:row.id})));
        list.append(li);
      }
      fragment.append(branch);
    };
    if(!focus){
      if(documents.length||sources.length)fragment.append(overview(documents,sources));
      if(!documents.length&&!sources.length)fragment.append(el('p','Papers and sources saved in this project will appear here.'));
    }else if(focus.kind==='paper'){
      const linked=sources.filter(source=>pinned(record,source));
      children('Assigned source editions',linked);
      if(!linked.length)fragment.append(el('p','No sources have been assigned to this manuscript.'));
      fragment.append(button('Open manuscript',async()=>{try{await openPaper(record.id);}catch(e){body.append(el('p',e.message));}}));
    }else{
      const entry=catalog.library?.find(s=>s.sourceId===record.sourceId&&s.version===record.version);
      fragment.append(el('p',entry?.coverage||record.level?.replaceAll('_',' ')));
      if(entry?.retrievedAt)fragment.append(el('small','Retrieved '+entry.retrievedAt));
      if(entry?.note)fragment.append(el('p',entry.note));
      const url=entry?.url||(record.doi?'https://doi.org/'+record.doi:'');
      if(/^https?:\/\//i.test(url)){
        const link=el('a',entry?.doi||record.doi||url);link.href=url;link.target='_blank';link.rel='noopener noreferrer';fragment.append(link);
      }
      if(entry?.originalUri){
        const a=el('a','Download original');a.href=entry.originalUri;a.download=entry.originalFile;fragment.append(a);
      }
      const papers=documents.filter(paper=>pinned(paper,record));children('Manuscripts using this edition',papers);
      if(!papers.length)fragment.append(el('p','No manuscript is linked to this edition.'));
    }
    body.replaceChildren(fragment);
  }
  async function refresh(){
    if(!element.open||loading)return;
    const g=generation;loading=true;
    if(!catalog)body.textContent='Loading project records…';
    try{const data=await load();if(g===generation){catalog=data;draw();}}
    catch(e){if(g===generation)body.replaceChildren(el('p',e.message),button('Reload project records',refresh));}
    finally{if(g===generation)loading=false;}
  }
  element.ontoggle=()=>{if(element.open)refresh();};
  return {element,refresh,reset(){generation++;loading=false;catalog=null;focus=null;element.open=false;body.replaceChildren();}};
}};
