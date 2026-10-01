import {test,expect,afterEach} from 'vitest';
import {mkdtemp,readdir,rm,readFile,writeFile,chmod,link,rename,symlink} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {CodexRuntimeManager,observeRetainedCliLease} from '../src/codexRuntime.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'retained-cli-')),manager=new CodexRuntimeManager({root,discoverExternal:false,environment:{}});roots.push(root);
 const release=await manager.lease({id:'fixture',source:'terminal',command:'/fixture/codex',physicalPath:'/fixture/codex',version:'0.153.4'});
 const directory=join(root,'leases'),file=join(directory,(await readdir(directory))[0]);return {root,manager,release,directory,file};}
test('original retained passive lease stays byte-identical and ordinary release still removes it',async()=>{const f=await fixture(),bytes=await readFile(f.file);expect(observeRetainedCliLease(f.release)).toBe(true);expect(observeRetainedCliLease(f.release)).toBe(true);expect(await readFile(f.file)).toEqual(bytes);await f.release();expect(await readdir(f.directory)).toEqual([]);expect(observeRetainedCliLease(f.release)).toBe(false);});
test('foreign or wrapped release is never accepted by function shape',async()=>{const f=await fixture();expect(observeRetainedCliLease(()=>f.release())).toBe(false);expect(observeRetainedCliLease(new Proxy(f.release,{}))).toBe(false);expect(observeRetainedCliLease({then(){throw Error('must not call');}})).toBe(false);});
for(const mode of ['bytes','same-bytes-replaced-inode','file-mode','directory-mode','hardlink','symlink','missing'])test('retained lease '+mode+' fails closed and remains uncertain after restoration',async()=>{
 const f=await fixture(),bytes=await readFile(f.file);expect(observeRetainedCliLease(f.release)).toBe(true);
 if(mode==='bytes')await writeFile(f.file,Buffer.from('x'.repeat(bytes.length)));
 if(mode==='same-bytes-replaced-inode'){await rename(f.file,f.file+'.old');await writeFile(f.file,bytes,{mode:0o600});}
 if(mode==='file-mode')await chmod(f.file,0o644);if(mode==='directory-mode')await chmod(f.directory,0o755);
 if(mode==='hardlink')await link(f.file,f.file+'.linked');if(mode==='symlink'){await rename(f.file,f.file+'.old');await symlink(f.file+'.old',f.file);}
 if(mode==='missing')await rm(f.file);expect(observeRetainedCliLease(f.release)).toBe(false);
 if(mode==='bytes')await writeFile(f.file,bytes);if(mode==='file-mode')await chmod(f.file,0o600);if(mode==='directory-mode')await chmod(f.directory,0o700);
 expect(observeRetainedCliLease(f.release)).toBe(false);
});
