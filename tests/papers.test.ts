import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { Storage } from '../runtime/storage.ts';
import { Papers, inspectLinks, manuscriptSectionChecks } from '../runtime/papers.ts';
import { privateTestDirectory } from './platform-test-helpers.ts';

test('paper source and version references are project-bound and missing evidence is retained', t=>{
  const dir=privateTestDirectory(join(tmpdir(),'papers-')),db=new Storage(dir),p=new Papers(db);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  for(const id of ['one','two'])db.putProject({id,name:id});
  const src=p.saveSource('one','Data','potential 19 mV');
  const d=p.create('one',{title:'Study',goal:'Report voltage',evidence:[src]});
  assert.throws(()=>p.source('two',src.sourceId));assert.throws(()=>p.paper('two',d.id));
  assert.throws(()=>p.create('two',{title:'Foreign',goal:'Inspect',evidence:[src]}));
  const v=p.save('one',d.id,{title:'Study',text:'Other data 10.1000/missing',expectedCurrentVersion:null,evidence:[src],review:{status:'approved'}});
  assert.equal(v.review.status,'unreviewed');assert.equal(v.issues.length,2);
  assert.throws(()=>p.version('two',d.id,v.version));assert.throws(()=>p.save('one',d.id,{...v,expectedCurrentVersion:null}),{code:'VERSION_CONFLICT'});
  const target={kind:'artifact' as const,id:'data',projectId:'one',sessionId:'s',version:'v',sha256:src.sha256,bytes:15};
  const body='Figure 1. Potential in volts.';
  const figure={kind:'figure',quote:body,sourceId:src.sourceId,locator:'row 1',excerpt:'19 mV',caption:body,variable:'potential',unit:'V',transformation:'none'};
  const invalid=inspectLinks([figure],body,[{...src,origin:target}]);
  assert.ok(invalid.issues.some(i=>i.includes('unit')));
  const corrected=inspectLinks([{...figure,unit:'mV'}],body,[{...src,origin:target}]);
  assert.ok(!corrected.issues.some(i=>i.includes('unit')));
});

test('older compiled editions retain their download while an updated renderer is available',t=>{
  const dir=privateTestDirectory(join(tmpdir(),'paper-renderer-')),db=new Storage(dir),papers=new Papers(db);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  db.putProject({id:'project',name:'Project'});
  const key='papers.v1:'+JSON.stringify(['project','typeset',JSON.stringify(['document','version'])]);
  const pdf={id:'original',uri:'/api/artifacts/session/original'};
  db.set(key,{state:'succeeded',template:'article',engine:'pdflatex',version:'version',pdf});
  const historic=papers.compilation('project','document','version');
  assert.ok(historic && 'updateAvailable' in historic && historic.updateAvailable);
  assert.deepEqual(historic.pdf,pdf);
});

test('saved section checks use Markdown heading boundaries and exact quote offsets',()=>{
  const text=['# Study','Results is mentioned in the introduction.','', 'Methods','-------','Tested one specimen.',
    '```text','# Example heading','```','> ## Quoted heading','', '## Results','Measured 19 mV.',
    '### Sensitivity','Measured 20 mV.','## Results','A second check.'].join('\r\n');
  const link=(quote:string,sourceOffset=0)=>({kind:'claim' as const,quote,sourceId:'source',excerpt:quote,locator:'table',
    manuscriptOffset:text.indexOf(quote),sourceOffset});
  const links=[link('Results is mentioned'),link('Tested one'),link('Measured 19'),link('Measured 20'),link('A second'),link('mV.',-1)];
  assert.deepEqual(manuscriptSectionChecks({text,title:'Original project title',links}),[
    {heading:'Methods',linkedPassages:1},{heading:'Results',linkedPassages:1},
    {heading:'Sensitivity',linkedPassages:1},{heading:'Results',linkedPassages:1}]);
});
