'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');

const catalog={
  documents:[
    {id:'calibration',title:'Circuit calibration',evidence:[{sourceId:'reference',version:'v1'}]},
    {id:'filter',title:'Filter response',evidence:[{sourceId:'reference',version:'v1'},{sourceId:'old',version:'v1'}]},
    {id:'protocol',title:'Proposed protocol',evidence:[]}
  ],
  sources:[
    {sourceId:'reference',version:'v1',title:'Reference measurements'},
    {sourceId:'old',version:'v2',title:'Updated reference manual'}
  ]
};
async function render(load=async()=>catalog,clock=Date){
  const {window,document}=parseHTML('<main></main>');
  vm.runInNewContext(readFileSync(join(__dirname,'../ui/project-graph.js'),'utf8'),{document,window,Date:clock});
  const opened=[];
  const {element,refresh}=window.AthenaProjectGraph.create({load,openPaper:async id=>opened.push(id)});
  document.querySelector('main').append(element);element.open=true;await refresh();
  const button=label=>[...element.querySelectorAll('button')].find(b=>b.textContent===label);
  return {element,button,opened,refresh};
}
test('two manuscripts converge on one exact edition with separately selectable unlinked project records',async()=>{
  const {element,button,opened}=await render();
  const network=element.querySelector('.ac-map-network');
  assert.equal(network.querySelectorAll('.ac-map-source').length,1);
  const edges=[...network.querySelectorAll('svg path')];
  assert.deepEqual(edges.map(p=>[p.dataset.paperId,p.dataset.sourceId,p.dataset.version]),
    [['calibration','reference','v1'],['filter','reference','v1']]);
  assert.notEqual(edges[0].getAttribute('d'),edges[1].getAttribute('d'));
  assert.equal(network.querySelectorAll('button').length,3);
  const isolated=element.querySelector('.ac-map-isolated');
  assert.deepEqual([...isolated.querySelectorAll('button')].map(b=>b.textContent),['Proposed protocol','Updated reference manual']);
  const shared=button('Reference measurements');
  assert.match(shared.getAttribute('aria-description'),/Circuit calibration, Filter response/);
  shared.onfocus();assert.equal(network.querySelectorAll('path.ac-map-related').length,2);
  button('Filter response').onfocus();assert.equal(network.querySelectorAll('path.ac-map-related').length,1);
  shared.click();assert.equal(element.querySelector('h4').textContent,'Reference measurements');
  assert.ok(button('Circuit calibration'));button('Filter response').click();
  await button('Open manuscript').onclick();assert.deepEqual(opened,['filter']);
  button('← Project library').click();button('Updated reference manual').click();
  assert.match(element.textContent,/No manuscript is linked to this edition/);
});

test('an expanded graph picks up newly saved literature without rebuilding unchanged nodes',async()=>{
  let time=10000,calls=0;
  const data=structuredClone(catalog);
  const {element,button,refresh}=await render(async()=>{calls++;return data;},{now:()=>time});
  const original=button('Reference measurements');
  await refresh(true);assert.equal(calls,1);
  time+=6000;await refresh(true);
  assert.equal(button('Reference measurements'),original);
  data.sources.push({sourceId:'added',version:'v1',title:'Newly retrieved article'});
  time+=6000;await refresh(true);
  assert.ok(button('Newly retrieved article'));
  element.open=false;time+=6000;await refresh(true);assert.equal(calls,3);
});
