import { paperElements, paperText, parsePaperXml } from './crossref.ts';
import { fetchBytes, journalArchive } from './open-papers.ts';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { Storage } from './storage.ts';
import { Papers, type PaperSource } from './papers.ts';
import { ManagerError, hash } from './orchestration.ts';

interface OpenPaper {url:string;format:'pdf'|'xml';bytes:Buffer;text:string}
export type PaperAcquisition=(doi:string,signal:AbortSignal)=>Promise<OpenPaper|undefined>;
type Entry = {sourceId:string;version:string;title:string;url:string;doi?:string;retrievedAt:string;coverage:string;
  note:string;original?:{file:string;url:string;sha256:string};detail?:string};
const limit=8*1024*1024;
export const acquireOpenPaper:PaperAcquisition=async(doi,signal)=>{
  // Use repository-owned public endpoints. Never follow a publisher-provided download URL.
  const stop=AbortSignal.any([signal,AbortSignal.timeout(6500)]);
  const arxiv=/^10\.48550\/arxiv\.(\d{4}\.\d{4,5}(?:v\d+)?)$/i.exec(doi);
  const journal=journalArchive(doi);
  if(arxiv||journal){
    const url=journal?journal+'.pdf':'https://arxiv.org/pdf/'+arxiv![1],bytes=await fetchBytes(url,stop,limit);
    if(bytes.subarray(0,5).toString()!=='%PDF-')throw Error('Repository did not return a PDF.');
    const text=await new Promise<string>(resolve=>{
      const extractor=execFile('pdftotext',['-f','1','-l','60','-','-'],{timeout:4000,maxBuffer:1024*1024,windowsHide:true,signal},(err,stdout)=>resolve(err?'':stdout.trim()));
      extractor.stdin?.on('error',()=>{}); // The optional extractor can exit before consuming its input.
      extractor.stdin?.end(bytes);
    });
    signal.throwIfAborted();
    return {url,bytes,format:'pdf',text};
  }
  const search=new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
  search.search=new URLSearchParams({query:'DOI:"'+doi.replace(/["\\]/g,'')+'" AND OPEN_ACCESS:Y',format:'json',pageSize:'3'}).toString();
  const result=JSON.parse((await fetchBytes(search.href,stop,128000)).toString());
  const item=result.resultList?.result?.find((r:Record<string,unknown>)=>String(r.doi).toLowerCase()===doi&&r.isOpenAccess==='Y'&&/^PMC\d+$/.test(String(r.pmcid)));
  if(!item)return;
  const url='https://www.ebi.ac.uk/europepmc/webservices/rest/'+item.pmcid+'/fullTextXML';
  const bytes=await fetchBytes(url,stop,limit),xml=bytes.toString('utf8');
  const body=paperElements(parsePaperXml(xml),'body').next().value;
  if(!body?.children.length)throw Error('Repository returned no article body.');
  return {url,bytes,format:'xml',text:paperText(body)};
};
function safeDir(path:string){
  try{mkdirSync(path,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  if(realpathSync(path)!==path||!lstatSync(path).isDirectory())throw new ManagerError('LIBRARY_FOLDER','Choose an accessible project folder with a regular Athena Library directory.');
}
function saveOnce(dir:string,name:string,data:Buffer){
  const target=join(dir,name),tmp=join(dir,'.'+randomUUID()+'.tmp');
  writeFileSync(tmp,data,{flag:'wx',mode:0o600});
  try{
    try{linkSync(tmp,target);}catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      const stat=lstatSync(target);
      if(!stat.isFile()||stat.size!==data.length)throw new ManagerError('LIBRARY_CONFLICT','A library file was changed. Restore or move it before retrying.');
      const fd=openSync(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      try{if(!fstatSync(fd).isFile()||!readFileSync(fd).equals(data))throw new ManagerError('LIBRARY_CONFLICT','The saved library file differs from its verified version.');}finally{closeSync(fd);}
    }
  }finally{unlinkSync(tmp);}
}
export class ProjectLibrary {
  private readonly db:Storage;
  private readonly papers:Papers;
  private readonly root:string;
  private readonly acquire:PaperAcquisition;
  constructor(db:Storage,papers:Papers,root:string,acquire:PaperAcquisition=acquireOpenPaper){
    this.db=db;this.papers=papers;this.root=root;this.acquire=acquire;
  }
  private key(project:string){return 'library.v1:'+project;}
  private entries(project:string){return this.db.get<Entry[]>(this.key(project))??[];}
  private directory(project:string){
    const p=this.db.project(project);if(!p)throw new ManagerError('PROJECT_NOT_FOUND','Select a project.');
    const base=p.folder?.path??join(realpathSync(this.root),'projects',project);
    if(realpathSync(base)!==base)throw new ManagerError('LIBRARY_FOLDER','The selected project directory moved.');
    const library=join(base,'Athena Library'),directory=join(library,project);
    safeDir(library);safeDir(directory);return directory;
  }
  private writeNote(dir:string,entry:Entry,source:PaperSource){
    const fields=[
      'Source: '+entry.url,
      'Retrieved: '+entry.retrievedAt,
      'Coverage: '+entry.coverage,
      entry.detail,
      entry.original && 'Original: '+entry.original.file,
      'Edition: '+source.version,
    ].filter(Boolean);
    const note=['# '+source.title,'',...fields,'',source.content,''].join('\n');
    saveOnce(dir,entry.note,Buffer.from(note));
  }
  private store(project:string,source:PaperSource,metadata:Omit<Entry,'sourceId'|'version'|'title'|'note'|'original'>,full?:OpenPaper){
    const old=this.entries(project).find(r=>r.sourceId===source.sourceId);
    if(old){
      const dir=this.directory(project);
      if(full&&old.original)saveOnce(dir,old.original.file,full.bytes);
      this.writeNote(dir,old,source);
      return old;
    }
    if(this.entries(project).length>=256)throw new ManagerError('LIBRARY_LIMIT','The project library is full.');
    const dir=this.directory(project);
    const title=Array.from(source.title.normalize('NFKC').replace(/[^\p{L}\p{N} -]/gu,'').trim()).slice(0,36).join('')||'Paper';
    const stem='Paper - '+title+' - '+source.sourceId.slice(0,20);
    const original=full?{file:stem+'.'+full.format,url:full.url,sha256:hash(full.bytes)}:undefined;
    const entry:Entry={...metadata,sourceId:source.sourceId,version:source.version,title:source.title,note:stem+'.md',...(original?{original}:{})};
    if(full&&original)saveOnce(dir,original.file,full.bytes);
    this.writeNote(dir,entry,source);
    this.db.transaction(()=>this.db.set(this.key(project),[...this.entries(project),entry]));return entry;
  }
  async savePaper(project:string,source:PaperSource,signal:AbortSignal){
    const ref=source.origin;if(!ref||!('providerId' in ref))throw Error('Expected a bibliography record.');
    const prior=this.entries(project).find(r=>{
      if(r.doi!==ref.providerId||!r.original)return false;
      const origin=this.papers.source(project,r.sourceId).origin;
      return origin&&'rawSha256' in origin&&origin.rawSha256===ref.rawSha256;
    });
    if(prior){
      try{
        this.original(project,prior.sourceId);
        this.writeNote(this.directory(project),prior,this.papers.source(project,prior.sourceId));
        return prior;
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      }
    }
    let full:OpenPaper|undefined,detail:string|undefined;
    try{full=await this.acquire(ref.providerId,signal);}catch(error){signal.throwIfAborted();detail='Full text retrieval: '+String((error as Error).message).slice(0,200);}
    signal.throwIfAborted();
    const meta={url:'https://doi.org/'+ref.providerId,doi:ref.providerId,retrievedAt:ref.retrievedAt};
    if(!full)return this.store(project,source,{...meta,coverage:source.level,detail});
    const indexed=Buffer.from(full.text);
    const excerpt=indexed.subarray(0,140000).toString('utf8').replace(/\0/g,'').trim();
    const edition=this.papers.saveSource(project,source.title,source.content+'\n\nOriginal: '+full.url+'\nSHA-256: '+hash(full.bytes)+'\n\n'+excerpt,excerpt?'full_text':source.level,{...ref,fullTextAcquired:true});
    return this.store(project,edition,{...meta,coverage:full.format.toUpperCase()+(indexed.length>140000?' · partial text index':excerpt?' · indexed text':' · metadata indexed')},full);
  }
  savePassage(project:string,page:{url:string;retrievedAt:string;claim:string;coverage:string},receipt:PaperSource,excerpt:string){
    const content=[page.url,excerpt,'Research use: '+page.claim,'Receipt SHA-256: '+receipt.sha256].join('\n\n');
    const source=this.papers.saveSource(project,'Visited page: '+new URL(page.url).hostname,content,'full_text');
    return this.store(project,source,{url:page.url,retrievedAt:page.retrievedAt,coverage:'Visited passage'});
  }
  read(project:string,id:string,version?:unknown){
    const entry=this.entries(project).find(r=>r.sourceId===id&&(!version||r.version===version));
    if(!entry)throw new ManagerError('SOURCE_DENIED','This edition is unavailable in the selected project.');
    return {entry,source:this.papers.source(project,id)};
  }
  search(project:string,query:string,maximum=20){
    const terms=query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
    return this.entries(project).map(entry=>{
      const source=this.papers.source(project,entry.sourceId),title=(entry.title+' '+(entry.doi??'')).toLowerCase(),body=source.content.toLowerCase();
      const score=terms.reduce((sum,t)=>sum+(title.includes(t)?3:body.includes(t)?1:0),0);
      const start=Math.max(0,(terms.length?body.indexOf(terms.find(t=>body.includes(t))??''):0)-80);
      return {entry,score,excerpt:source.content.slice(start,start+720)};
    }).filter(r=>!terms.length||r.score).sort((a,b)=>b.score-a.score||b.entry.retrievedAt.localeCompare(a.entry.retrievedAt)).slice(0,maximum).map(({entry,excerpt})=>({...entry,excerpt}));
  }
  original(project:string,id:string){
    const {entry}=this.read(project,id),file=entry.original;
    if(!file)throw new ManagerError('SOURCE_DENIED','No original was retrieved for this edition.');
    const path=join(this.directory(project),file.file);
    if(!lstatSync(path).isFile())throw new ManagerError('SOURCE_DENIED','Original file unavailable.');
    const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try{
      const stat=fstatSync(fd);
      if(!stat.isFile()||stat.size>limit)throw new ManagerError('SOURCE_DENIED','Original file changed.');
      const bytes=readFileSync(fd);
      if(hash(bytes)!==file.sha256)throw new ManagerError('SOURCE_DENIED','Original file changed.');
      return {bytes,name:file.file.endsWith('.pdf')?'paper.pdf':'paper.xml',mimeType:file.file.endsWith('.pdf')?'application/pdf':'application/xml'};
    }finally{closeSync(fd);}
  }
  uiSources(project:string,conversation:string){
    return {sources:this.entries(project).map(e=>({projectId:project,sourceId:e.sourceId,version:e.version,title:e.title,kind:'documents',format:e.original?.file.endsWith('.pdf')?'Article':'Paper',
      text:this.papers.source(project,e.sourceId).content,createdAt:e.retrievedAt,persistence:'host',originalLocation:{uri:e.url,label:'Athena Library/'+project+'/'+e.note},
      coverage:e.coverage,detail:e.detail,originalFile:e.original?.file,originalUri:e.original?'/api/artifacts/'+conversation+'/library-'+e.sourceId:undefined,extraction:{status:'ready',version:e.version},review:{status:'unreviewed',version:e.version}}))};
  }
}
