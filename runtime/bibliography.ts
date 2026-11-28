import { randomUUID } from 'node:crypto';
import { Storage } from './storage.ts';
import { Papers, bounded } from './papers.ts';
import { canonicalDoi, publicationMetadata, SearchError, type Candidate, type SearchSpec, type BibliographicProvider } from './crossref.ts';
import { hash, ManagerError, object } from './orchestration.ts';

interface Result extends Candidate { retrievedAt:string }
interface Search extends SearchSpec {
  id:string;sessionId:string;requestId:string;createdAt:string;status:'authorized'|'running'|'succeeded'|'failed'|'partial'|'cached'|'cancelled'|'interrupted';
  pageCount:number;records:Result[];error?:string;retrievedAt?:string;cacheOrigin?:string;
  execution?:{runId:string;taskId:string;attemptId:string;toolId:string};
}
function summary(row:Search){
  return {...row,records:row.records.map(r=>({doi:r.doi,title:r.title,level:r.abstract?'abstract':'metadata',retrievedAt:r.retrievedAt}))};
}
export class Bibliography {
  private readonly db:Storage;
  private readonly papers:Papers;
  private readonly provider:BibliographicProvider;
  private readonly active=new Map<string,AbortController>();
  private readonly jobs=new Set<Promise<unknown>>();
  constructor(db:Storage,papers:Papers,provider:BibliographicProvider){this.db=db;this.papers=papers;this.provider=provider;}
  private key(project:string,id:string){return 'bibliography.v1:'+JSON.stringify([project,this.provider.id,id]);}
  private ids(project:string){return this.db.get<string[]>(this.key(project,''))??[];}
  private row(project:string,id:string){
    const row=this.db.get<Search>(this.key(project,id));
    if(!row)throw new ManagerError('SEARCH_DENIED','Search unavailable in this project.');
    if(row.status==='running'&&!this.active.has(id)){row.status='interrupted';this.save(project,row);}
    return row;
  }
  private save(project:string,row:Search){this.db.set(this.key(project,row.id),row);}
  private scoped(project:string,session:string,id:string){
    const row=this.row(project,id);
    if(row.sessionId!==session)throw new ManagerError('SEARCH_DENIED','Open the conversation that authorized the search.');
    return row;
  }
  list(project:string,session:string){return this.ids(project).map(id=>this.row(project,id)).filter(r=>r.sessionId===session).reverse().map(summary);}
  prepare(project:string,session:string,args:Record<string,unknown>){
    const term=bounded(args.term,'explicit search term',300).trim(),requestId=bounded(args.requestId,'request ID',128);
    if(args.mode!=='query'&&args.mode!=='doi')throw new SearchError('invalid_mode');
    const pages=args.pages??1;if(pages!==1&&(pages!==2||args.mode!=='query'))throw new SearchError('invalid_pages');
    const spec:SearchSpec={mode:args.mode,term:args.mode==='doi'?canonicalDoi(term):term,pages};
    return this.db.transaction(()=>{
      const ids=this.ids(project);
      const existing=ids.map(id=>this.row(project,id)).find(r=>r.requestId===requestId&&r.sessionId===session);
      if(existing){
        if(existing.mode!==spec.mode||existing.term!==spec.term||existing.pages!==pages)throw new SearchError('request_changed');
        return summary(existing);
      }
      if(ids.length>=128)throw new SearchError('history_limit');
      const row:Search={...spec,id:randomUUID(),sessionId:session,requestId,createdAt:new Date().toISOString(),status:'authorized',records:[],pageCount:0};
      this.save(project,row);this.db.set(this.key(project,''),[...ids,row.id]);return summary(row);
    });
  }
  execute(project:string,session:string,id:string,signal?:AbortSignal,execution?:Search['execution']){
    const job=this.run(project,session,id,signal,execution);this.jobs.add(job);
    job.then(()=>this.jobs.delete(job),()=>this.jobs.delete(job));return job;
  }
  private async run(project:string,session:string,id:string,signal?:AbortSignal,execution?:Search['execution']){
    const row=this.scoped(project,session,id);
    if(row.status!=='authorized')return summary(row);
    signal?.throwIfAborted();row.execution=execution;
    const previous=this.ids(project).map(key=>this.row(project,key)).reverse().find(r=>r.mode===row.mode&&r.term===row.term&&r.pages===row.pages&&r.status==='succeeded'&&Date.now()-Date.parse(r.retrievedAt!)<600000);
    if(previous){
      Object.assign(row,{status:'cached',cacheOrigin:previous.id,retrievedAt:previous.retrievedAt,pageCount:previous.pageCount,records:previous.records});
      this.save(project,row);return summary(row);
    }
    const controller=new AbortController(),deadline=AbortSignal.timeout(20000);
    const stop=AbortSignal.any([controller.signal,deadline,...signal?[signal]:[]]);
    this.active.set(id,controller);row.status='running';this.save(project,row);
    try {
      await this.provider.retrieve(row,stop,(records,at)=>{
        stop.throwIfAborted();row.retrievedAt=at;row.pageCount++;
        for(const record of records)if(!row.records.some(r=>r.doi===record.doi))row.records.push({...record,retrievedAt:at});
        this.save(project,row);
      });
      stop.throwIfAborted();row.status='succeeded';
    }catch(error){
      row.error=deadline.aborted?'timeout':stop.aborted?'cancelled':error instanceof SearchError?error.code:'network_error';
      row.status=row.error==='cancelled'?'cancelled':row.pageCount?'partial':'failed';
    }finally{this.save(project,row);this.active.delete(id);}
    return summary(row);
  }
  cancel(project:string,session:string,id:string){
    const row=this.scoped(project,session,id);
    this.active.get(id)?.abort();
    if(row.status==='authorized'){row.status='cancelled';this.save(project,row);}
    return summary(row);
  }
  add(project:string,session:string,id:string,doi:unknown){
    const row=this.scoped(project,session,id),record=row.records.find(r=>r.doi===canonicalDoi(doi));
    if(!record||hash(JSON.stringify(record.raw))!==record.rawSha256)throw new SearchError('record_unavailable');
    const metadata=record.raw;
    const {authors,date}=publicationMetadata(metadata);
    const journal=Array.isArray(metadata['container-title'])?metadata['container-title'][0]:undefined;
    const content=[record.title,'DOI: '+record.doi,authors.length&&'Authors: '+authors.join(', '),
      date&&'Issued: '+date,typeof journal==='string'&&'Published in: '+journal,record.abstract].filter(Boolean).join('\n');
    return this.papers.saveSource(project,record.title,content,record.abstract?'abstract':'metadata',{
      provider:record.provider??this.provider.id,providerId:record.doi,query:row.term,retrievedAt:record.retrievedAt,raw:record.raw,rawSha256:record.rawSha256,
      hasAbstract:!!record.abstract,fullTextLinks:record.links,fullTextAcquired:false});
  }
  async close(){for(const c of this.active.values())c.abort();await Promise.allSettled(this.jobs);}
}
