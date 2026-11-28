import assert from 'node:assert/strict';
import test from 'node:test';
import { parseManuscriptJson,sectionBriefs,streamedManuscript } from '../runtime/manuscript-draft.ts';
import { manuscriptTex } from '../runtime/typesetting.ts';
const outline=['Methods','Results'];
const msg=(...content:unknown[])=>({role:'assistant',content});
test('partial public section text is visible without emitting reasoning, readbacks or malformed headings',()=>{
  const hidden={type:'thinking',thinking:'private'}, writer=(text:string)=>msg(hidden,{type:'text',text});
  assert.equal(streamedManuscript('writer',writer('[{"heading":"Methods","text":"First obser'),outline),'## Methods\nFirst obser');
  assert.equal(streamedManuscript('writer',writer('[{"heading":"Wrong","text":"no"}]'),outline),undefined);
  assert.equal(streamedManuscript('writer',writer('I am looking up the source.'),outline),undefined);
  assert.equal(streamedManuscript('editor',msg(hidden,{type:'toolCall',name:'read_file',arguments:{text:'contents'}}),outline),undefined);
  assert.equal(streamedManuscript('editor',msg({type:'toolCall',name:'publish_manuscript',arguments:{text:'Revised result'}}),outline),'Revised result');
  assert.equal(streamedManuscript('writer',{role:'toolResult',content:[{type:'text',text:'sensitive'}]},outline),undefined);
});
test('fenced writer replies stream public sections while final validation requires complete JSON',()=>{
  const json='[{"heading":"Methods","text":"Samples"}]';
  assert.deepEqual(parseManuscriptJson('```json\n'+json+'\n```'),JSON.parse(json));
  assert.throws(()=>parseManuscriptJson('```json\n'+json),/valid JSON/);
  assert.throws(()=>parseManuscriptJson('Introduction\n'+json),/valid JSON/);
  assert.equal(streamedManuscript('writer',msg({type:'text',text:'```json\n'+json.slice(0,-4)}),outline),'## Methods\nSample');
});
test('section briefs resolve only the selected source editions in the approved outline order',()=>{
  const ref={sourceId:'first',version:'v3'}, row={heading:'Methods',purpose:'Compare paired samples',sources:[1],visual:'Plot paired observations'};
  assert.deepEqual(sectionBriefs([row],['Methods'],[ref])[0]?.sources,[ref]);
  for(const sources of [[0],[2],['1'],[1,1]])assert.throws(()=>sectionBriefs([{...row,sources}],['Methods'],[ref]));
  assert.throws(()=>sectionBriefs([row],['Results'],[ref]));
});
test('method diagram typesetting requires ordered text in the pinned full-text source, and escapes labels',()=>{
  const id='a'.repeat(64),figure='![Sampling method](athena-diagram:'+id+'/Sample%20A/Compute%205%25)';
  const render=(content:string)=>manuscriptTex('Study',figure,'article',[],undefined,[],[{sourceId:id,content}]);
  assert.match(render('Sample A then Compute 5%'),/Compute 5\\%/);
  assert.throws(()=>render('Compute 5% then Sample A'),/out of order/);
  assert.throws(()=>manuscriptTex('Study',figure,'article'),/full-text source/);
});
