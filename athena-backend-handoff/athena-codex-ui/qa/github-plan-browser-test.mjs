// Acceptance against the upstream GitHub MCP executable. Only GitHub REST and the model are fixtures.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createFixture } from './chat-browser-fixture.mjs';

const binary = process.env.ATHENA_QA_GITHUB_BINARY;
if (!binary) throw Error('Set ATHENA_QA_GITHUB_BINARY to the official github-mcp-server executable (tested with v2.3.0).');
const evidence = process.env.ATHENA_BROWSER_EVIDENCE || await mkdtemp(join(tmpdir(),'athena-plan-evidence-'));
await mkdir(evidence,{recursive:true});
const scratch = await mkdtemp(join(tmpdir(),'athena-plan-test-'));
const sha = execFileSync('git',['rev-parse','origin/main'],{encoding:'utf8'}).trim();
const endpoint = 'https://api.githubcopilot.com/mcp/x/repos/readonly';
const token = 'github_pat_athena_test_only';
const restCalls = [];
const rest = createServer((req,res)=>{
  restCalls.push({method:req.method, path:req.url});
  res.setHeader('Content-Type','application/json');
  if (req.url.split('?')[0] === '/api/v3/repos/yanaire/athena/branches' && req.headers.authorization?.endsWith(token)) {
    res.end(JSON.stringify([{name:'main',protected:false,commit:{sha}}]));
  } else {res.writeHead(404);res.end('{"message":"Not found"}');}
});
const listen = async server => { server.listen(0,'127.0.0.1'); await once(server,'listening'); return server.address().port; };
const restPort = await listen(rest);
const portProbe = createServer();
const port = await listen(portProbe);
await new Promise(resolve=>portProbe.close(resolve));
const mcp = spawn(binary,['http','--listen-host','127.0.0.1','--port',String(port),'--read-only','--toolsets','repos','--gh-host','http://127.0.0.1:'+restPort],{stdio:['ignore','ignore','pipe']});
let serverLogs='';
mcp.stderr.on('data',chunk=>{serverLogs=(serverLogs+chunk).slice(-3000);});
const plan = {objective:'Identify the revision to use for a reproducible Athena run',
  stages:['Read branch references from the selected GitHub repository','Locate main and retain its commit SHA'],
  acceptanceCriteria:['The saved GitHub tool response contains a 40-character SHA for main.']};
const markers=[];
let fixture,browser,context,start;
const mark=step=>markers.push({step,seconds:(Date.now()-start)/1000});
const call=(name,args)=>({name,args});
async function respond({coordinator,outputs,input,messages}) {
  await delay(400);
  if (!coordinator) {
    if (!outputs.length) return call('call_external_mcp',{serverId:'athena-github/repositories',tool:'list_branches',arguments:{owner:'yanaire',repo:'athena',perPage:5}});
    assert.ok(outputs[0].includes(sha),outputs[0].slice(0,600));
    return 'The main branch points to '+sha+'.';
  }
  if (input.includes('Check the planning guard')) {
    if (!outputs.length) return call('spawn_agent',{role:'experiment',title:'Premature work',prompt:'Start without a plan.'});
    assert.match(outputs[0],/must call plan_research/);
    return 'The host requires a coordinator plan first.';
  }
  if (!outputs.length) {
    assert.match(JSON.stringify(messages),/design the plan yourself/);
    return call('plan_research',plan);
  }
  if (outputs.length===1) return call('spawn_agent',{role:'worker',title:'Read GitHub branches',prompt:'Use the GitHub repository connection to check the main branch.'});
  if (outputs.length===2) return call('wait_for_agents',{});
  const child=JSON.parse(outputs[2]).tasks[0];
  assert.equal(child.status,'succeeded');assert.ok(child.artifacts.length);
  return 'GitHub returned main at '+sha+'. The tool receipt is saved.';
}

try {
  // The production descriptor stays fixed. Only this test host routes it to the local upstream executable.
  const preload=join(scratch,'local-upstream.mjs');
  await writeFile(preload,"const fetchOriginal = globalThis.fetch;\nglobalThis.fetch = (url, options) => fetchOriginal(String(url) === "
    + JSON.stringify(endpoint)+" ? "+JSON.stringify('http://127.0.0.1:'+port+'/mcp/x/repos/readonly')+" : url, options);\n");
  fixture=await createFixture(respond,{hostNodeArgs:['--import',preload]});
  const {rpc}=fixture;
  const {project}=await rpc('createProject',[{name:'GitHub replication check',researchWorkflow:true}]);
  const {sessionId}=await rpc('createSession',[{projectId:project.id,title:'Select an Athena revision'}]);
  browser=await chromium.launch({executablePath:process.env.ATHENA_CHROMIUM||undefined});
  context=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:evidence,size:{width:1440,height:900}}});
  start=Date.now();
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(fixture.origin);
  await page.waitForFunction(()=>window.AthenaApp?.getState().workspace.sessionBound);
  await page.locator('[data-action="settings"]').first().click();
  await page.locator('#ast-tab-tools').click();
  const install=page.getByRole('button',{name:'Install GitHub plugin'});
  await install.waitFor();mark('install');await delay(800);await install.click();
  const card=page.locator('[data-aex-plugin="athena-github"]');
  await card.waitFor();
  assert.equal(await card.getByRole('button',{name:'Enable',exact:true}).isDisabled(),true);
  const connect=card.getByRole('button',{name:'Connect and enable GitHub'});
  await connect.click();
  await page.locator('[data-aex-error]').filter({hasText:/credential/}).waitFor();
  await card.locator('[data-aex-token]').fill(token);
  mark('connect');await connect.click();
  await card.getByText('Connection checked',{exact:true}).waitFor({timeout:12000});
  await card.getByText('Enabled',{exact:true}).waitFor();
  const ext=await rpc('getExtensions',[project.id]);
  const plugin=ext.plugins.find(p=>p.id==='athena-github'),server=plugin.servers[0];
  assert.deepEqual(server.verification.tools.map(t=>t.name).sort(),['list_branches','list_commits','search_repositories']);
  assert.equal(server.url,endpoint);assert.ok(server.credentialConfigured);
  assert.ok(!JSON.stringify(ext).includes(token));
  await card.scrollIntoViewIfNeeded();await delay(700);await page.screenshot({path:join(evidence,'github.png')});
  await page.getByRole('button',{name:'Close settings'}).click();
  await page.locator('#ac-prompt-input').fill('Plan how to make this study reproducible, then identify the main revision of yanaire/athena on GitHub.');
  mark('request');await page.getByRole('button',{name:'Send message',exact:true}).click();
  const details=page.locator('.ac-flow-stages details').filter({has:page.locator('strong',{hasText:'Research plan'})}).first();
  await details.locator('summary').click();
  await details.getByText(plan.stages[1],{exact:true}).waitFor();
  mark('plan');await delay(500);await page.screenshot({path:join(evidence,'plan.png')});
  const complete=await fixture.waitSnapshot(s=>s.run.status==='succeeded'&&s.processes?.some(p=>p.status==='succeeded'));
  const report=await rpc('researchFlow',[{projectId:project.id,sessionId}]);
  assert.equal(report.plan.objective,plan.objective);
  assert.deepEqual(report.plan.stages,plan.stages);
  assert.deepEqual(report.plan.acceptanceCriteria,plan.acceptanceCriteria);
  assert.equal(report.plan.coordinatorModel,'browser-fixture');
  const connection=report.connections.find(c=>c.name==='GitHub repositories');
  assert.ok(connection.calls.some(c=>c.tool==='list_branches'&&c.status==='succeeded'));
  const artifact=complete.artifacts.find(a=>a.file?.name==='mcp-result.json');
  const bytes=await (await page.request.get(fixture.origin+artifact.location.uri)).body();
  assert.ok(bytes.includes(sha));assert.ok(!bytes.includes(token));
  await writeFile(join(evidence,'mcp-result.json'),bytes);
  mark('receipt');await page.getByText('GitHub returned main at '+sha+'. The tool receipt is saved.',{exact:true}).filter({visible:true}).first().waitFor();
  await delay(1300);await page.screenshot({path:join(evidence,'result.png')});
  await context.close();context=null;
  await fixture.stopHost();await fixture.startHost();
  const restored=await rpc('researchFlow',[{projectId:project.id,sessionId}]);
  assert.deepEqual(restored.plan,report.plan);
  assert.ok((await rpc('getExtensions',[project.id])).plugins.find(p=>p.id===plugin.id).enabled);
  await rpc('pi',[sessionId,{type:'prompt',id:'negative-plan-check',message:'Check the planning guard'}]);
  const negative=await fixture.waitSnapshot(s=>s.run.id!==complete.run.id && s.run.status==='succeeded');
  assert.ok(!negative.tasks.some(t=>t.title==='Premature work'));
  assert.ok(!(await rpc('researchFlow',[{projectId:project.id,sessionId}])).plan);
  assert.deepEqual(errors,[]);
  await writeFile(join(evidence,'verification.json'),JSON.stringify({runId:report.runId,plan:report.plan,server:server.verification.serverInfo,protocol:server.verification.protocolVersion,
    endpoint,tools:server.allowedTools,restCalls,sha,markers,model:'controlled local provider',transport:'official local GitHub MCP executable with REST fixture',restored:true,blockedPrematureWorker:true},null,2));
  console.log('Verified GitHub MCP and coordinator plan:',evidence);
} catch(error) {console.error(serverLogs);console.error(await context?.pages()[0]?.locator('[data-aex-error]').textContent().catch(()=>''));console.error((await context?.pages()[0]?.locator('body').innerText())?.slice(-3000));throw error;}
finally {await context?.close();await browser?.close();await fixture?.close();mcp.kill();rest.closeAllConnections();rest.close();await rm(scratch,{recursive:true,force:true});}
