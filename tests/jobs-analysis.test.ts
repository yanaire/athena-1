import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test, {type TestContext} from 'node:test';
import {AnalysisFiles} from '../runtime/analysis-files.ts';
import {CsvJobRunner, type CsvJobRunnerOptions, type CsvAttempt} from '../runtime/jobs.ts';
import {lockedSandboxIdentity} from '../scripts/analysis-provenance.mjs';
import {assertKilled, windows} from './platform-test-helpers.ts';

const scope={projectId:'project',sessionId:'session',taskId:'task'};
const identity={...scope,attemptId:'one',requestId:'req',toolId:'tool'};
const job=(source:string)=>({...identity,language:'python' as const,script:{name:'main.py',bytes:Buffer.from(source)},inputs:[],outputs:[]});
const live={timeout:60000};
async function fixture(t:TestContext,opts:Partial<CsvJobRunnerOptions>={}) {
  const dir=await mkdtemp(join(tmpdir(),'athena-analysis-')); const files=new AnalysisFiles(dir);
  const runner=new CsvJobRunner({dataDir:dir,...opts});
  t.after(async()=>{await runner.close();await rm(dir,{recursive:true,force:true});});
  return {dir,files,runner};
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; throw error; }
}

async function orphanExited(pid: number): Promise<boolean> {
  if (!alive(pid)) return true;
  if (process.platform !== 'linux') return false;
  // Some container init processes leave exited orphans visible to kill(pid, 0).
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    return /^State:\s+Z\b/m.test(status);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) return !alive(pid);
    throw error;
  }
}

test('analysis rejects a script with an extension mismatched to the selected interpreter',async t=>{
  const {runner}=await fixture(t);
  assert.throws(() => runner.startAnalysis({...job('print(42)'), language:'node'}), {code:'INVALID_INPUT'});
});

test('Python works on frozen inputs, enforces isolation, and publishes reusable outputs plus the exact source',live,async t=>{
  // This fixture tests capabilities and publication, not the short-job deadline.
  const {runner,files,dir}=await fixture(t,{timeoutMs:30000});
  const access=await runner.analysisAccess(); assert.ok(access.available,JSON.stringify(access));
  const {identity: sandboxIdentity}=await lockedSandboxIdentity();
  assert.equal(access.engine, sandboxIdentity.replace('athena-sandbox/1 wasmtime/', 'Wasmtime '));
  assert.match(access.node.version,/^QuickJS-ng /); assert.match(access.python.version,/^CPython 3\./);
  const auth=join(dir,'auth'); await mkdir(auth,{mode:0o700});
  const canary=join(auth,'credentials.v2.json');
  await writeFile(canary,'synthetic host credentials',{mode:0o600});
  const source=[
    "import errno, os, sys, pathlib, importlib.util, subprocess",
    "p=pathlib.Path",
    "assert set(os.environ) <= {'PYTHONHOME', 'LC_CTYPE'}",
    "assert importlib.util.find_spec('js') is None",
    "try: import ctypes",
    "except ImportError: pass",
    "else: raise AssertionError('native ctypes backend available')",
    "assert not p(sys.argv[1]).exists() and sys.argv[2]=='--literal;$(unused)'",
    "try: import socket",
    "except ImportError: pass",
    "else:",
    " try: socket.socket()",
    " except OSError: pass",
    " else: raise AssertionError('unexpected socket support')",
    "try: subprocess.run(['/usr/bin/true'], check=True)",
    "except (OSError, NotImplementedError): pass",
    "else: raise AssertionError('native process started')",
    "for dest in ['source.txt','/workspace/extra.txt','/outputs/extra.txt','/runtime/extra.txt','/outputs/../escape.txt']:",
    " try: p(dest).write_text('not allowed')",
    " except OSError: pass",
    " else: raise AssertionError(dest)",
    "try: os.write(100, b'x')",
    "except OSError as e: assert e.errno == errno.EBADF",
    "else: raise AssertionError('write to an invalid descriptor succeeded')",
    "p('/outputs/answer.txt').write_text(p('source.txt').read_text().upper())",
    "p('/outputs/empty.txt').write_text('')",
    "print('finished')",
  ].join('\n');
  const inputs=[{name:'source.txt',bytes:Buffer.from('granted'),fileId:'f',versionId:'v'}];
  const request={...job(source),inputs,outputs:['answer.txt','empty.txt'],args:[canary,'--literal;$(unused)']};
  await files.write(scope,'main.py','newer workspace revision');
  const handle=runner.startAnalysis(request); inputs[0]?.bytes.fill(0); request.script.bytes.fill(0);
  const result=await handle.result; assert.equal(result.status,'succeeded',result.error+' '+result.stderr);
  assert.equal(result.analysis?.engine,access.engine);
  assert.equal(result.stdout,'finished\n'); assert.ok(result.executionId && result.pid); assert.equal(alive(result.pid), false);
  const [script,answer,empty]=result.artifacts??[]; assert.ok(script && answer && empty);
  assert.deepEqual((result.artifacts??[]).map(a=>a.name),['main.py','answer.txt','empty.txt']);
  assert.equal((await files.download(script)).toString(),source); assert.equal((await files.download(answer)).toString(),'GRANTED');
  assert.equal((await files.download(empty)).length,0); assert.equal(await files.read(scope,'main.py'),'newer workspace revision');
  const [firstAttempt] = await readdir(join(dir,'csv-jobs','attempts'));
  assert.ok(firstAttempt);
  assert.deepEqual(await readdir(join(dir,'csv-jobs','attempts',firstAttempt)),[]);
  const snapshots=await files.snapshot(scope,['answer.txt']);
  const second=await runner.startAnalysis({...identity,attemptId:'two',language:'node',script:{name:'reuse.mjs',bytes:Buffer.from("import * as std from 'qjs:std'; import * as os from 'qjs:os'; if (std.open('/outputs/extra.txt','w') || os.exec || globalThis.process || globalThis.fetch) throw Error('unexpected capability'); const f=std.open('/outputs/result.json','w'); f.puts(JSON.stringify(std.loadFile('answer.txt'))); f.close();")},inputs:snapshots,outputs:['result.json']}).result;
  assert.equal(second.status,'succeeded',second.error+' '+second.stderr); assert.equal(await files.read(scope,'result.json'),'"GRANTED"');
});

test('a successful interpreter without its declared file fails without publishing partial artifacts',live,async t=>{
  const {runner,files}=await fixture(t);
  const result=await runner.startAnalysis({...job("open('/outputs/present.txt','w').write('ok')"),outputs:['present.txt','absent.txt']}).result;
  assert.equal(result.exitCode,0); assert.equal(result.status,'failed'); assert.match(result.error??'',/not written: absent.txt/);
  assert.equal(result.artifacts,undefined); assert.equal(await files.has(scope,'present.txt'),false);
});

test('analysis completion persistence failure withholds every artifact after a successful WASI execution', live, async t => {
  const saved: CsvAttempt[] = [];
  let failed = false;
  const { runner } = await fixture(t, { onEvent(event) {
    if (event.type !== 'process_finished') return;
    if (!failed) {
      assert.equal(event.attempt.status, 'succeeded');
      assert.equal(event.attempt.artifacts?.length, 2);
      failed = true;
      throw new Error('Synthetic analysis completion persistence failure');
    }
    saved.push(event.attempt);
  } });
  const access = await runner.analysisAccess();
  assert.ok(access.available, JSON.stringify(access));
  const result = await runner.startAnalysis({ ...job("open('/outputs/answer.txt','w').write('computed')"), outputs: ['answer.txt'] }).result;
  assert.equal(failed, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.analysis?.backend, 'wasi');
  assert.match(result.error ?? '', /persist.*completion/i);
  assert.equal(result.artifact, undefined);
  assert.equal(result.artifacts, undefined);
  assert.deepEqual(saved, [result]);
});

test('an invalid declared JSON result fails the publication of the source and every output',live,async t=>{
  const {runner,files}=await fixture(t);
  const result=await runner.startAnalysis({...job("open('/outputs/summary.txt','w').write('complete')\nopen('/outputs/result.json','w').write(str({'n': 3}))"),
    outputs:['summary.txt','result.json']}).result;
  assert.equal(result.exitCode,0);
  assert.equal(result.status,'failed');
  assert.match(result.error??'',/result\.json is not valid JSON/);
  assert.equal(result.artifacts,undefined);
  assert.equal(await files.has(scope,'summary.txt'),false);
  assert.equal(await files.has(scope,'result.json'),false);
});

test('the WASI memory cap stops analysis before an oversized allocation can produce output',live,async t=>{
  const {runner,files}=await fixture(t);
  const result=await runner.startAnalysis({...job("payload = bytearray(256 * 1024 * 1024)\nopen('/outputs/marker.txt', 'w').write('past cap')"),
    outputs:['marker.txt']}).result;
  assert.equal(result.status,'failed',result.error);
  assert.match(result.stderr,/memory maximum size exceeded|forcing trap when growing memory|MemoryError/i);
  assert.equal(result.artifacts,undefined);
  assert.equal(await files.has(scope,'marker.txt'),false);
});

const looping="while True: pass";
for(const mode of ['cancelled','timed_out'] as const) test('the runner reaps an executing sandbox when '+mode,live,async t=>{
  const started=Promise.withResolvers<CsvAttempt>();
  const {runner,dir}=await fixture(t,{timeoutMs:mode==='timed_out'?2000:10000,onEvent:event=>{
    if(event.type==='process_started')started.resolve(event.attempt);
  }});
  const handle=runner.startAnalysis(job(looping));
  const receipt=await Promise.race([started.promise,handle.result]);assert.ok(receipt.executionId && receipt.pid,receipt.error);
  assert.equal(alive(receipt.pid),true);
  if(mode==='cancelled'){
    const restored=Promise.withResolvers<CsvAttempt>();
    const reopened=new CsvJobRunner({dataDir:dir,recoveredAttempts:[receipt],onEvent:e=>restored.resolve(e.attempt)});t.after(()=>reopened.close());
    assert.equal((await restored.promise).status,'interrupted'); assert.equal(alive(receipt.pid),true);
    assert.throws(()=>reopened.startAnalysis(job(looping)),{code:'DUPLICATE_ATTEMPT'});
    handle.cancel();
  }
  const result=await handle.result; assert.equal(result.status,mode,result.error); assert.equal(result.cancellation,'confirmed');
  assert.equal(result.artifacts,undefined); assert.equal(alive(receipt.pid),false);
  const [attempt] = await readdir(join(dir,'csv-jobs','attempts'));
  assert.ok(attempt);
  assert.deepEqual(await readdir(join(dir,'csv-jobs','attempts',attempt)),[]);
});

for (const scenario of [
  {name:'captured output', source:"open('/outputs/marker.txt','w').write('synthetic')\nprint('x' * 16385)"},
  {name:'output file size', source:"open('/outputs/marker.txt','w').write('x' * (1024 * 1024 + 1))"},
]) test(`benign ${scenario.name} overflow fails without artifacts and removes scratch`,live,async t=>{
  // Let the guest reach the byte limit on every native architecture.
  const {runner,files,dir}=await fixture(t,{timeoutMs:30000});
  const result=await runner.startAnalysis({...job(scenario.source),outputs:['marker.txt']}).result;
  assert.equal(result.status,'failed',result.error);
  assert.ok(result.executionId, 'the interpreter must start before exercising the output limit');
  assert.equal(result.artifacts,undefined);
  assert.equal(await files.has(scope,'marker.txt'),false);
  const [attempt] = await readdir(join(dir,'csv-jobs','attempts'));
  assert.ok(attempt);
  assert.deepEqual(await readdir(join(dir,'csv-jobs','attempts',attempt)),[]);
});

for (const signal of (windows ? ['SIGTERM'] : ['SIGTERM','SIGXCPU']) as NodeJS.Signals[]) test(`a signalled interpreter records ${signal} with the correct outcome`, live, async t => {
  const { runner } = await fixture(t, { onEvent(event) {
    if (event.type === 'process_started') {
      assert.ok(event.attempt.pid);
      process.kill(event.attempt.pid, signal);
    }
  } });
  const result = await runner.startAnalysis({ ...identity, language: 'node',
    script: { name: 'wait.mjs', bytes: Buffer.from('while (true) {}') }, inputs: [], outputs: [] }).result;
  assert.equal(result.status, signal === 'SIGXCPU' ? 'timed_out' : 'failed');
  assertKilled(result.exitCode, result.signal, signal);
  if (signal === 'SIGXCPU') {
    assert.match(result.error ?? '', /exceeded its time limit/);
    assert.equal(result.cancellation, 'confirmed');
  } else assert.match(result.error ?? '', windows ? /SIGTERM during analysis|returned 1|exited with code 1/ : /SIGTERM during analysis/);
  assert.equal(result.artifacts, undefined);
});

test('a guest exit cannot impersonate the native memory watchdog',live,async t=>{
  const {runner}=await fixture(t);
  const result=await runner.startAnalysis(job('import sys\nsys.exit(126)')).result;
  assert.equal(result.status,'failed');
  assert.equal(result.exitCode,1);
  assert.doesNotMatch(result.error??'',/memory accounting/);
});

test('killing the Node host closes the sandbox liveness pipe',live,async t=>{
  const {dir}=await fixture(t);const childDir=join(dir,'owner');await mkdir(childDir,{mode:0o700});
  const url=new URL('../runtime/jobs.ts',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',
    'import {CsvJobRunner} from '+JSON.stringify(url)+';const runner=new CsvJobRunner({dataDir:process.argv[1],timeoutMs:10000,onEvent:e=>{if(e.type==="process_started") console.log(e.attempt.pid);}}); const request='+JSON.stringify({...job(''),script:undefined})+';const result=await runner.startAnalysis({...request,script:{name:"main.py",bytes:Buffer.from('+JSON.stringify(looping)+')}}).result; if (result.status==="failed") console.error(result.error);',childDir],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  let diagnostic=''; child.stderr.on('data',chunk=>{diagnostic+=chunk;});
  const died=once(child,'exit'); const id=await Promise.race([once(child.stdout,'data').then(([bytes])=>String(bytes).trim()),died.then(()=>{throw new Error('host died before ready: '+diagnostic);})]);
  assert.match(id,/^[1-9]\d*$/);const pid=Number(id);assert.equal(alive(pid),true);child.kill('SIGKILL');await died;
  const end=Date.now()+4000; while(!(await orphanExited(pid))) {assert.ok(Date.now()<end,'sandbox did not exit after liveness pipe closed');await delay(50);}
});
