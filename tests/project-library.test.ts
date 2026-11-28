import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Storage } from '../runtime/storage.ts';
import { Papers } from '../runtime/papers.ts';
import { acquireOpenPaper, ProjectLibrary } from '../runtime/project-library.ts';
import { projectFolder } from '../runtime/project-folder.ts';
import { hash } from '../runtime/orchestration.ts';
import { privateTestDirectory } from './platform-test-helpers.ts';

test('a project keeps the retrieved original, searchable edition and access scope across restart',async t=>{
  const internal=privateTestDirectory(join(tmpdir(),'athena-index-'));
  const folder=mkdtempSync(join(tmpdir(),'athena-papers-'));
  let db=new Storage(internal),papers=new Papers(db);
  t.after(()=>{db.close();rmSync(internal,{recursive:true,force:true});rmSync(folder,{recursive:true,force:true});});
  const selected=projectFolder(folder,internal);
  for(const id of ['a','b'])db.putProject({id,name:id,folder:selected});
  const xml=Buffer.from('<article><body>A spectrum peaks at 690 nm.</body></article>');
  let requests=0;
  const open=()=>new ProjectLibrary(db,papers,internal,async(doi)=>{
    requests++;
    if(doi.endsWith('short'))throw Error('HTTP 403');
    return {format:'xml',bytes:xml,url:'https://example.org/open.xml',text:'A spectrum peaks at 690 nm.'};
  });
  let library=open();
  const origin=(id:string)=>({provider:'Crossref',providerId:'10.1234/'+id,query:'optics',raw:{id},rawSha256:hash(JSON.stringify({id})),
    hasAbstract:false,fullTextLinks:[],fullTextAcquired:false,retrievedAt:'2026-03-18T00:00:00.000Z'});
  const base=papers.saveSource('a','Visible spectrum','Publication metadata','metadata',origin('optics'));
  const signal=new AbortController().signal,entry=await library.savePaper('a',base,signal);
  assert.equal(entry.original?.sha256,hash(xml));
  const archive=join(folder,'Athena Library','a');
  assert.match(readFileSync(join(archive,entry.note),'utf8'),/peaks at 690 nm/);
  assert.deepEqual(library.original('a',entry.sourceId).bytes,xml);
  assert.equal((await library.savePaper('a',base,signal)).sourceId,entry.sourceId);
  assert.equal(requests,1);
  rmSync(join(archive,entry.note));
  await library.savePaper('a',base,signal);
  assert.match(readFileSync(join(archive,entry.note),'utf8'),/peaks at 690 nm/);assert.equal(requests,1);
  rmSync(join(archive,entry.original!.file));
  await library.savePaper('a',base,signal);
  assert.deepEqual(library.original('a',entry.sourceId).bytes,xml);assert.equal(requests,2);
  const metadata=await library.savePaper('a',papers.saveSource('a','Short citation','No full article','metadata',origin('short')),signal);
  assert.equal(metadata.coverage,'metadata');assert.match(metadata.detail!,/403/);
  assert.equal(metadata.original,undefined);
  db.close();db=new Storage(internal);papers=new Papers(db);library=open();
  assert.equal(library.search('a','690')[0]?.version,entry.version);
  assert.equal(library.read('a',entry.sourceId,entry.version).source.level,'full_text');
  assert.throws(()=>library.read('a',entry.sourceId,'wrong version'),/unavailable/);
  assert.throws(()=>library.read('b',entry.sourceId,entry.version),/unavailable/);
  assert.deepEqual(library.search('b','spectrum'),[]);
  writeFileSync(join(archive,entry.original!.file),'modified');
  assert.throws(()=>library.original('a',entry.sourceId),/changed/);
  if(process.platform!=='win32'){
    renameSync(join(folder,'Athena Library'),join(folder,'moved'));
    symlinkSync(join(folder,'moved'),join(folder,'Athena Library'));
    assert.throws(()=>library.original('a',entry.sourceId),/accessible project folder/);
  }
});

test('Europe PMC indexes body text once and retains the exact JATS source',async t=>{
  const doi='10.1000/optics';
  const raw='<!DOCTYPE article SYSTEM "journal.dtd"><article><front><title>Metadata only</title></front><body><sec><title>Mixtures &amp; optics</title>'+
    '<p data-label="A > B">H<sub>2</sub>O at &#x3B2;.</p><p><![CDATA[x < y]]>; &amp;lt; denotes encoded text.</p>'+
    '<table><tr><td>Peak</td><td>690 nm</td></tr></table></sec></body><back>Bibliography</back></article>';
  const urls:string[]=[];
  t.mock.method(globalThis,'fetch',async (url:URL|string)=>{
    urls.push(String(url));
    return urls.length===1?Response.json({resultList:{result:[{doi,isOpenAccess:'Y',pmcid:'PMC12345'}]}}):new Response(raw);
  });
  const acquired=await acquireOpenPaper(doi,new AbortController().signal);
  assert.equal(acquired?.format,'xml');
  assert.deepEqual(acquired?.bytes,Buffer.from(raw));
  assert.equal(acquired?.text,'Mixtures & optics\nH2O at β.\nx < y; &lt; denotes encoded text.\nPeak 690 nm');
  assert.deepEqual(urls.map(url=>new URL(url).pathname),['/europepmc/webservices/rest/search','/europepmc/webservices/rest/PMC12345/fullTextXML']);
});
