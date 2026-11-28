import { parseXml, XmlElement, XmlText } from '@rgrove/parse-xml';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchBytes, journalArchive } from './open-papers.ts';
import { hash, object } from './orchestration.ts';

export type SearchSpec = {mode:'query'|'doi'; term:string; pages:number};
export type Candidate = {provider?:string;doi:string; title:string; abstract:string; links:string[]; raw:Record<string,unknown>; rawSha256:string};
export interface BibliographicProvider {
  readonly id:string;
  retrieve(spec:SearchSpec, signal:AbortSignal, page:(records:Candidate[], retrievedAt:string)=>void):Promise<void>;
}
export class SearchError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.code=code;}
}
export function canonicalDoi(value:unknown) {
  if(typeof value!=='string'||value.length>300||!/^10\.\d{4,9}\/[^\s\u0000-\u001f<>]+$/i.test(value))throw new SearchError('invalid_doi');
  return value.toLowerCase();
}
export function publicationMetadata(raw:unknown){
    const metadata=object(raw)?raw:{};
    const authors=Array.isArray(metadata.author)?metadata.author.flatMap(author=>{
      if(!object(author))return [];
      const name=[author.given,author.family].filter(v=>typeof v==='string').join(' ')||author.name;
      return typeof name==='string'?[name]:[];
    }):[];
    const issued=object(metadata.issued)?metadata.issued['date-parts']:undefined;
    const date=Array.isArray(issued)&&Array.isArray(issued[0])?issued[0].join('-'):'';
    return {authors,date};
}

// Fetches bound the byte length. Also bound tree allocation for markup-heavy articles.
export function parsePaperXml(source:string):XmlElement {
  let delimiters=0;
  for(let i=source.indexOf('<');i!==-1;i=source.indexOf('<',i+1)){
    if(++delimiters>150_000)throw new SearchError('record_too_large');
  }
  // The parser never loads DTDs. Keep unknown named references as literal source text.
  try {
    const root=parseXml(source,{maxElementDepth:128,ignoreUndefinedEntities:true}).root;
    if(root)return root;
  } catch { /* Report the provider failure without storing parser excerpts. */ }
  throw new SearchError('malformed');
}

function localName(element:XmlElement) {
  return element.name.slice(element.name.lastIndexOf(':')+1).toLowerCase();
}

export function* paperElements(root:XmlElement,name:string):Generator<XmlElement> {
  if(localName(root)===name)yield root;
  for(const child of root.children){
    if(child instanceof XmlElement)yield* paperElements(child,name);
  }
}

export function paperText(element:XmlElement):string {
  const chunks:string[]=[];
  const blocks=new Set(['p','title','sec','list-item','caption','tr','break']);
  function collect(node:XmlElement){
    for(const child of node.children){
      if(child instanceof XmlElement)collect(child);
      else if(child instanceof XmlText)chunks.push(child.text);
    }
    const name=localName(node);
    if(blocks.has(name))chunks.push('\n');
    else if(name==='td'||name==='th')chunks.push(' ');
  }
  collect(element);
  return chunks.join('').replace(/[\t ]+/g,' ').trim();
}

function abstractText(source:string) {
  if(!source)return '';
  let text=source;
  try {text=paperText(parsePaperXml('<abstract>'+source+'</abstract>'));}
  catch { /* Crossref also accepts plain-text abstracts with literal comparison signs. */ }
  return text.replace(/\s+/g,' ').trim();
}

function candidate(raw:unknown):Candidate {
  if(!object(raw)||typeof raw.DOI!=='string')throw new SearchError('malformed');
  let doi:string;try {doi=canonicalDoi(raw.DOI);}catch{throw new SearchError('malformed');}
  const rawJson=JSON.stringify(raw);
  if(Buffer.byteLength(rawJson)>64000)throw new SearchError('record_too_large');
  const title=Array.isArray(raw.title)&&typeof raw.title[0]==='string'?raw.title[0].trim():'';
  const abstract=typeof raw.abstract==='string'?abstractText(raw.abstract):'';
  const links=Array.isArray(raw.link)?raw.link.flatMap(l=>object(l)&&typeof l.URL==='string'&&/^https?:\/\//i.test(l.URL)?[l.URL]:[]):[];
  return {doi,title:title.slice(0,512)||doi,abstract,links,raw,rawSha256:hash(rawJson)};
}
async function readJson(response:Response){
  if(!response.body)throw new SearchError('malformed');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>512000){await reader.cancel();throw new SearchError('response_too_large');}chunks.push(value);}
  }finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new SearchError('malformed');}
}
export class CrossrefProvider implements BibliographicProvider {
  readonly id='crossref';
  private next=0;
  private busy=false;
  private readonly transport:typeof fetch;
  constructor(transport:typeof fetch=fetch){this.transport=transport;}
  async retrieve(spec:SearchSpec,signal:AbortSignal,page:(records:Candidate[], retrievedAt:string)=>void){
    if(this.busy)throw new SearchError('busy');
    this.busy=true;
    try {
      for(let index=0;index<spec.pages;index++){
        const spacing=spec.mode==='query'?1000:200;
        while(Date.now()<this.next)await delay(Math.min(20000,this.next-Date.now()),undefined,{signal});
        signal.throwIfAborted();
        const url=new URL('https://api.crossref.org/works'+(spec.mode==='doi'?'/'+encodeURIComponent(canonicalDoi(spec.term)):''));
        if(spec.mode==='query'){url.searchParams.set('query.bibliographic',spec.term);url.searchParams.set('rows','5');url.searchParams.set('offset',String(index*5));}
        this.next=Date.now()+spacing;
        const archive=spec.mode==='doi'&&journalArchive(spec.term);
        if(archive){
          const sourceUrl=archive+'.crossref.xml';
          const bytes=await fetchBytes(sourceUrl,signal,64000,this.transport);
          const root=parsePaperXml(bytes.toString('utf8'));
          const article=paperElements(root,'journal_article').next().value;
          if(!article)throw new SearchError('malformed');
          const field=(element:XmlElement,name:string)=>paperElements(element,name).next().value?.text.trim()??'';
          const doiData=paperElements(article,'doi_data').next().value;
          const titles=paperElements(article,'titles').next().value;
          const doi=field(doiData??article,'doi'),title=field(titles??article,'title');
          if(doi.toLowerCase()!==spec.term||!title)throw new SearchError('malformed');
          const authors=Array.from(paperElements(article,'person_name'))
            .filter(person=>person.attributes.contributor_role==='author')
            .map(person=>({given:field(person,'given_name'),family:field(person,'surname')}));
          const year=field(article,'year');
          const record=candidate({DOI:doi,title:[title],author:authors,'container-title':['Journal of Open Source Software'],
            issued:{'date-parts':year?[[Number(year)]]:[]},link:[{URL:archive+'.pdf'}],sourceUrl,depositSha256:hash(bytes)});
          page([{...record,provider:'Open Journals Crossref deposit'}],new Date().toISOString());return;
        }
        const response=await this.transport(url,{headers:{Accept:'application/json','User-Agent':'Athena-Bibliography/1.0'},signal,redirect:'error'});
        const interval=/^(\d+(?:\.\d+)?)s$/i.exec(response.headers.get('x-rate-limit-interval')??'');
        const limit=Number(response.headers.get('x-rate-limit-limit'));
        if(interval&&limit>0)this.next=Math.max(this.next,Date.now()+Number(interval[1])*1000/limit);
        if(!response.ok){
          const retry=response.headers.get('retry-after');
          if(retry){const when=/^\d+$/.test(retry)?Date.now()+Number(retry)*1000:Date.parse(retry);if(Number.isFinite(when))this.next=Math.max(this.next,when);}
          await response.body?.cancel();
          throw new SearchError(({403:'forbidden',404:'not_found',429:'rate_limited'} as Record<number,string>)[response.status]??'provider_error');
        }
        const payload=await readJson(response);
        if(!object(payload)||payload.status!=='ok'||!object(payload.message))throw new SearchError('malformed');
        const message=payload.message;
        if(spec.mode==='doi'){
          const item=candidate(message);
          if(item.doi!==spec.term)throw new SearchError('malformed');
          page([item],new Date().toISOString());return;
        }
        if(!Array.isArray(message.items)||message.items.length>5)throw new SearchError('malformed');
        const rows=message.items.map(candidate);
        page(rows,new Date().toISOString());
        if(rows.length<5||typeof message['total-results']==='number'&&(index+1)*5>=message['total-results'])return;
      }
    }finally{this.busy=false;}
  }
}
