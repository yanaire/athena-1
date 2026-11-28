import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '../runtime/storage.ts';
import { Papers } from '../runtime/papers.ts';
import { Bibliography } from '../runtime/bibliography.ts';
import { hash } from '../runtime/orchestration.ts';
import { CrossrefProvider, type Candidate } from '../runtime/crossref.ts';
import { privateTestDirectory } from './platform-test-helpers.ts';
import type { TestContext } from 'node:test';
function setup(t:TestContext,transport:typeof fetch){
  const directory=privateTestDirectory(join(tmpdir(),'bibliography-'));
  const db=new Storage(directory);db.putProject({id:'p',name:'Test'});
  const papers=new Papers(db),provider=new CrossrefProvider(transport),lib=new Bibliography(db,papers,provider);
  t.after(async()=>{await lib.close();db.close();rmSync(directory,{recursive:true,force:true});});
  return {lib,papers,db,provider,prepare:(term='optical metrology',pages=1)=>lib.prepare('p','s',{mode:'query',term,pages,requestId:randomUUID()})};
}
const item=(i:number)=>({DOI:'10.1234/mock'+i,title:['Synthetic item '+i],link:[{URL:'https://example.org/paper'}],author:[{family:'Fixture'}]});
const result=(items:unknown[])=>Response.json({status:'ok',message:{items}});

test('search pages keep original provenance through partial failure and source deduplication',async t=>{
  const urls:URL[]=[];
  const {lib,prepare,db,papers}=setup(t,async url=>{urls.push(new URL(String(url)));return urls.length===1?result([1,2,3,4,1].map(item)):new Response(null,{status:429});});
  const {id}=prepare('explicit words',2);
  const row=await lib.execute('p','s',id);assert.equal(row.status,'partial');assert.equal(row.error,'rate_limited');
  assert.equal(row.records.length,4);assert.equal(urls[0]?.searchParams.get('query.bibliographic'),'explicit words');assert.equal(urls[1]?.searchParams.get('offset'),'5');
  const src=lib.add('p','s',id,item(1).DOI);
  assert.equal(src.level,'metadata');assert.equal(src.sourceId,lib.add('p','s',id,item(1).DOI.toUpperCase()).sourceId);
  assert.ok(src.origin&&'provider' in src.origin);assert.deepEqual(src.origin.raw,item(1));assert.deepEqual(src.origin.fullTextLinks,['https://example.org/paper']);
  assert.equal(src.origin.fullTextAcquired,false);assert.equal(src.origin.hasAbstract,false);
  assert.throws(()=>lib.add('p','other',id,item(1).DOI));await assert.rejects(lib.execute('other','s',id));
  db.set('papers.v1:'+JSON.stringify(['p','source',src.sourceId]),{...src,origin:{...src.origin,raw:item(2)}});
  assert.throws(()=>papers.source('p',src.sourceId),{code:'SOURCE_DENIED'});
});
test('successful empty result and persisted cache retain original retrieval time', async t=>{
  let calls=0;const {lib,db,provider,papers,prepare}=setup(t,async()=>{calls++;return result([]);});
  const first=await lib.execute('p','s',prepare().id);
  assert.equal(first.status,'succeeded');assert.deepEqual(first.records,[]);assert.ok(first.retrievedAt);
  const restored=new Bibliography(db,papers,provider),row=await restored.execute('p','s',prepare().id);
  assert.equal(row.status,'cached');assert.equal(row.retrievedAt,first.retrievedAt);assert.equal(row.cacheOrigin,first.id);assert.equal(calls,1);
});
for(const [status,reply] of Object.entries({
  forbidden:()=>new Response(null,{status:403}), rate_limited:()=>new Response(null,{status:429}),
  malformed:()=>new Response('{'),network_error:()=>{throw Error('disconnected');}, response_too_large:()=>new Response('x'.repeat(512001)),
})){
  test('Crossref records '+status+' separately from zero results',async t=>{
    const {lib,prepare}=setup(t,async()=>reply());const row=await lib.execute('p','s',prepare().id);
    assert.equal(row.status,'failed');assert.equal(row.error,status);assert.equal(row.retrievedAt,undefined);
  });
}
test('concurrent searches, cancellation, timeout and duplicate dispatch have distinct outcomes',async t=>{
  let requests=0;
  const {lib,prepare}=setup(t,async(_url,options)=>{
    requests++;const sig=options?.signal;return new Promise<Response>((_,reject)=>sig?.addEventListener('abort',()=>reject(sig.reason),{once:true}));
  });
  const first=prepare(),waiting=lib.execute('p','s',first.id);
  assert.equal((await lib.execute('p','s',first.id)).status,'running');
  assert.equal((await lib.execute('p','s',prepare('other').id)).error,'busy');
  lib.cancel('p','s',first.id);assert.equal((await waiting).status,'cancelled');assert.equal(requests,1);
  const deadline=new AbortController();t.mock.method(AbortSignal,'timeout',()=>deadline.signal);
  const expiring=lib.execute('p','s',prepare().id);deadline.abort();assert.equal((await expiring).error,'timeout');
});

test('a journal deposit retains the source digest while indexing XML text exactly once', async()=>{
  const doi='10.21105/joss.00024';
  const xml=`<?xml version="1.0"?><doi_batch><body><journal><journal_article>
    <titles><title>H<sub>2</sub> &amp; slopes &amp;lt; &#x3B2;</title></titles>
    <contributors><person_name contributor_role='author'><given_name>Anne</given_name><surname>Rose &amp; Reed</surname></person_name></contributors>
    <publication_date><year>2016</year></publication_date>
    <citation_list><citation><doi>10.1000/earlier-reference</doi></citation></citation_list>
    <doi_data><doi>${doi}</doi></doi_data>
  </journal_article></journal></body></doi_batch>`;
  const provider=new CrossrefProvider(async()=>new Response(xml));
  const records:Candidate[]=[];
  await provider.retrieve({mode:'doi',term:doi,pages:1},new AbortController().signal,rows=>records.push(...rows));
  assert.equal(records.length,1);
  const [record]=records;
  assert.ok(record);
  assert.equal(record.doi,doi);
  assert.equal(record.title,'H2 & slopes &lt; β');
  assert.deepEqual(record.raw.author,[{given:'Anne',family:'Rose & Reed'}]);
  assert.equal(record.raw.depositSha256,hash(xml));
  assert.equal(record.rawSha256,hash(JSON.stringify(record.raw)));
});

test('Crossref abstracts retain paragraph and inline scientific text', async()=>{
  const abstract='<jats:p>H<sub>2</sub>O &amp; CO<sub>2</sub>.</jats:p><jats:p><![CDATA[x < y]]> and &amp;lt;.</jats:p>';
  const literal='A mean < 5 & a range of 2 units.';
  const provider=new CrossrefProvider(async()=>result([{...item(1),abstract},{...item(2),abstract:literal}]));
  const records:Candidate[]=[];
  await provider.retrieve({mode:'query',term:'means',pages:1},new AbortController().signal,rows=>records.push(...rows));
  assert.deepEqual(records.map(record=>record.abstract),['H2O & CO2. x < y and &lt;.',literal]);
  assert.equal(records[0]?.raw.abstract,abstract);
});
