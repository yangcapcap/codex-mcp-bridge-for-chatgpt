import {test,expect,vi,afterEach} from 'vitest';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {CodexRuntimeManager} from '../src/codexRuntime.js';import {createExecutionRuntime} from '../src/executionRuntime.js';import {loadConfig} from '../src/config.js';
import {SupervisedProcessTreeRegistry} from '../src/processTreeSupervisor.js';import {WorkerTreeShutdownSupervisor} from '../src/workerTreeShutdownSupervisor.js';
import {syntheticIdToken} from './fixtures/syntheticAuth.js';
afterEach(()=>vi.restoreAllMocks());
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw e;}}
for(const isolated of [false,true])test('HOST acquired original CLI lease stays retained after actual actors exit: isolation '+isolated,async()=>{
 const root=await mkdtemp(join(tmpdir(),'cli-retained-host-')),command=resolve('test/fixtures/fake-codex-app-server.mjs'),pids:number[]=[];
 const environment={...process.env,HOME:root,CODEX_HOME:join(root,'.codex'),CODEX_MCP_BRIDGE_RUNTIME_HOME:join(root,'runtime'),CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:join(root,'state.sqlite'),CODEX_MCP_BRIDGE_NO_AUTH:'1'};
 await mkdir(environment.CODEX_HOME,{mode:0o700});await writeFile(join(environment.CODEX_HOME,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'synthetic-retained',id_token:syntheticIdToken('fixture-user','synthetic-retained')}}),{mode:0o600});
 const manager=new CodexRuntimeManager({root:environment.CODEX_MCP_BRIDGE_RUNTIME_HOME,environment,discoverExternal:false});
 const selection={id:'fixture',source:'terminal' as const,command,physicalPath:command,version:'0.153.4'},release=await manager.lease(selection);
 const file=join(manager.root,'leases',(await readdir(join(manager.root,'leases')))[0]),before=await readFile(file);
 vi.spyOn(CodexRuntimeManager.prototype,'acquire').mockResolvedValue({selection,release,fingerprint:'fixture'});
 const config=loadConfig(environment);config.upstreamPoolSize=1;const owner=new WorkerTreeShutdownSupervisor(new SupervisedProcessTreeRegistry());
 const runtime=createExecutionRuntime(config,{workerShutdownSupervisor:owner.supervisor,onWorkerProcessStarted:async(identity,binding)=>{pids.push(identity.pid);await owner.register(identity,binding);},onWorkerProcessExitObserved:(identity,binding)=>owner.markExited(identity,binding)},environment,{isolateCodexExecution:isolated,onExecutionProcessSpawn:pid=>pids.push(pid)});
 await runtime.prepareExecution({backendKind:'app-server',contextMode:'fresh'});
 const initial=await runtime.closeNonforcing({allowSigkillEscalation:false,graceMs:100}),snapshot=JSON.stringify(initial);let fresh=await runtime.observeNonforcingExit();
 for(let i=0;i<40&&!fresh.exited;i++){if(fresh.outcome==='uncertain')break;await wait(100);fresh=await runtime.observeNonforcingExit();}
 const after=await readFile(file),survivors=pids.filter(alive);console.log('CLI_RETAINED_ACTUAL_OBSERVATION',JSON.stringify({root,isolated,initial,fresh,pids,survivors,leaseUnchanged:before.equals(after),initialImmutable:snapshot===JSON.stringify(initial)}));
 expect(pids.length).toBeGreaterThan(0);expect(fresh.exited).toBe(true);expect(survivors).toEqual([]);expect(after).toEqual(before);expect(JSON.stringify(initial)).toBe(snapshot);
 // Disposable fixture cleanup only after actual exit; do not call original release after pin.
 if(fresh.exited&&survivors.length===0)await rm(root,{recursive:true,force:true});
},30000);
