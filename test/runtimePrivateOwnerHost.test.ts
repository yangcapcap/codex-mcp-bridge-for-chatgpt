import Database from 'better-sqlite3';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,expect} from 'vitest';
import {loadConfig} from '../src/config.js';
import {PassThrough} from 'node:stream';
import {createIsolatedHttpServer,createIsolatedStdioRuntime} from '../src/runtimeProcess.js';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function rows(file:string){const db=new Database(file,{readonly:true,fileMustExist:true});try{return db.prepare('SELECT instance_id,stopped_at,termination_reason,process_id FROM bridge_instances ORDER BY instance_id').all();}finally{db.close();}}
function alive(pid:number){try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}}
test('HOST actual private owner idle HTTP closes resources without durable writer retirement or SIGKILL',async()=>{
 const root=await mkdtemp(join(tmpdir(),'private-owner-nf-'));
 const file=join(root,'state.sqlite');const pids:number[]=[];
 const env={...process.env,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_HOST:'127.0.0.1',CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_ROOTS:root,CODEX_MCP_BRIDGE_RUNTIME_HOME:join(root,'runtime'),CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:file,CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE:join(root,'models.json'),CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:join(root,'skills')};
 const server=await createIsolatedHttpServer(loadConfig(env),{childEnvironment:env,onRuntimeProcessSpawn:pid=>pids.push(pid)});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
 await wait(200);const before=rows(file);
 // Never call ordinary close or force cleanup once this policy has pinned.
 const initial=await server.closeNonforcing!({allowSigkillEscalation:false,graceMs:100});
 const initialSnapshot=JSON.stringify(initial);let fresh=await server.observeNonforcingExit!();
 for(let n=0;n<40&&!fresh.exited;n++){await wait(100);fresh=await server.observeNonforcingExit!();if(fresh.outcome==='uncertain')break;}
 const after=rows(file),survivors=pids.filter(alive);
 console.log('PRIVATE_OWNER_NONFORCING_OBSERVATION',JSON.stringify({root,before,after,initial,fresh,initialImmutable:initialSnapshot===JSON.stringify(initial),pids,survivors,listening:server.listening}));
 expect(pids.length).toBe(1);expect(pids[0]).toBeGreaterThan(0);expect(fresh.exited).toBe(true);expect(survivors).toEqual([]);expect(server.listening).toBe(false);expect(after).toEqual(before);expect(JSON.stringify(initial)).toBe(initialSnapshot);
},30000);

test('HOST actual private owner idle stdio closes owned process and detaches caller pipes without retiring writer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'private-owner-stdio-nf-')),file=join(root,'state.sqlite'),pids:number[]=[];
 const env={...process.env,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_ROOTS:root,CODEX_MCP_BRIDGE_RUNTIME_HOME:join(root,'runtime'),CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:file,CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE:join(root,'models.json'),CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:join(root,'skills')};
 const input=new PassThrough(),output=new PassThrough();output.resume();
 const runtime=await createIsolatedStdioRuntime(loadConfig(env),{childEnvironment:env,input,output,onRuntimeProcessSpawn:pid=>pids.push(pid)});
 await wait(200);const before=rows(file);const initial=await runtime.closeNonforcing({allowSigkillEscalation:false,graceMs:100});const initialSnapshot=JSON.stringify(initial);let fresh=await runtime.observeNonforcingExit();
 for(let n=0;n<40&&!fresh.exited;n++){await wait(100);fresh=await runtime.observeNonforcingExit();if(fresh.outcome==='uncertain')break;}
 const after=rows(file),survivors=pids.filter(alive),pipes=(input as any)._readableState.pipes.length;
 console.log('PRIVATE_OWNER_STDIO_NONFORCING_OBSERVATION',JSON.stringify({root,before,after,initial,fresh,initialImmutable:initialSnapshot===JSON.stringify(initial),pids,survivors,pipes,inputFd:(input as any)._handle?.fd??null,outputFd:(output as any)._handle?.fd??null}));
 expect(pids.length).toBe(1);expect(fresh.exited).toBe(true);expect(survivors).toEqual([]);expect(pipes).toBe(0);expect(after).toEqual(before);expect(JSON.stringify(initial)).toBe(initialSnapshot);
 // Caller-owned fixture streams are disposed only after positive actual exit.
 input.destroy();output.destroy();
},30000);
