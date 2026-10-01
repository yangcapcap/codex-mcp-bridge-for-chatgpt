import {test,expect,vi} from 'vitest';
import {RuntimeResourceShutdown,type RuntimeResourceHooks} from '../src/runtimeResourceShutdown.js';
import {shutdownResult} from '../src/shutdown.js';
const policy={allowSigkillEscalation:false,graceMs:0} as const;
const exited=shutdownResult('exited');
function hooks(overrides:Partial<RuntimeResourceHooks>={}):RuntimeResourceHooks {
 return {pin:()=>true,close:async()=>exited,observe:()=>exited,...overrides};
}

test('planned actors all pin before any close, and closing does not delegate DB cleanup',async()=>{
 const owner=new RuntimeResourceShutdown(['read','execution','frontend']),calls:string[]=[];
 for(const name of ['read','execution','frontend'])owner.register(name,hooks({
  pin:()=>{calls.push('pin:'+name);return true;},close:async()=>{calls.push('close:'+name);return exited;}
 }));
 owner.sealReady();expect((await owner.close(policy)).exited).toBe(true);
 expect(calls).toEqual(['pin:read','pin:execution','pin:frontend','close:read','close:execution','close:frontend']);
 expect(owner.operations.isPinned).toBe(true);await expect(owner.operations.run(()=>1)).rejects.toThrow('PINNED');
});

test('missing startup resource permanently blocks receipt even after late construction closes',async()=>{
 const owner=new RuntimeResourceShutdown(['read','frontend']),late=vi.fn(async()=>exited);
 owner.register('read',hooks());const initial=await owner.close(policy);
 owner.register('frontend',hooks({close:late}));await Promise.resolve();
 expect(late).toHaveBeenCalledOnce();expect(initial.outcome).toBe('uncertain');
 expect((await owner.observe()).outcome).toBe('uncertain');expect(owner.retained.has('startup-incomplete')).toBe(true);
});

test('one pin error retains the raw failure and still pins/closes later actors',async()=>{
 const owner=new RuntimeResourceShutdown(['bad','good']),raw={original:'pin'},goodPin=vi.fn(()=>true as const),goodClose=vi.fn(async()=>exited);
 owner.register('bad',hooks({pin:()=>{throw raw;}}));owner.register('good',hooks({pin:goodPin,close:goodClose}));owner.sealReady();
 expect((await owner.close(policy)).outcome).toBe('uncertain');
 expect(goodPin).toHaveBeenCalledOnce();expect(goodClose).toHaveBeenCalledOnce();expect(owner.retained.get('pin:bad')).toBe(raw);
});

test('reentrant close receives original sealed Promise without repeating actors',async()=>{
 const owner=new RuntimeResourceShutdown(['actor']);let nested:unknown;const close=vi.fn(()=>{nested=owner.close(policy);return Promise.resolve(exited);});
 owner.register('actor',hooks({close}));owner.sealReady();const first=owner.close(policy);
 expect(nested).toBe(first);expect(owner.close(policy)).toBe(first);expect((await first).exited).toBe(true);expect(close).toHaveBeenCalledOnce();
});

test('settled close receipt cannot hide a held original application operation',async()=>{
 const owner=new RuntimeResourceShutdown(['actor']);owner.register('actor',hooks());owner.sealReady();
 let finish!:(v:object)=>void;const raw={original:true},operation=owner.operations.run(()=>new Promise<object>(r=>finish=r));
 const initial=await owner.close(policy);expect(initial.outcome).toBe('timeout');finish(raw);expect(await operation).toBe(raw);
 expect((await owner.observe()).exited).toBe(true);expect(initial.outcome).toBe('timeout');
});

test.each(['pin','close','observe'])('resource %s accessor is rejected without evaluation',async key=>{
 const owner=new RuntimeResourceShutdown(['actor']);let reads=0;const raw=hooks();
 Object.defineProperty(raw,key,{get(){reads++;return ()=>exited;}});
 expect(()=>owner.register('actor',raw)).toThrow('CAPABILITY_INVALID');expect(reads).toBe(0);
 expect((await owner.close(policy)).outcome).toBe('uncertain');expect(owner.retained.get('actor')).toBe(raw);
});

test.each(['close','observe'])('resource %s rejection retains exact failure without reading its message',async phase=>{
 const owner=new RuntimeResourceShutdown(['actor']);let reads=0;const raw=Object.defineProperty({},'message',{get(){reads++;return 'late';}});
 owner.register('actor',hooks(phase==='close'?{close:async()=>{throw raw;}}:{observe:()=>{throw raw;}}));owner.sealReady();
 expect((await owner.close(policy)).outcome).toBe('uncertain');expect(reads).toBe(0);
 expect(owner.retained.get(phase+'-error:actor')).toBe(raw);expect((await owner.observe()).outcome).toBe('uncertain');
});

test('unsupported close Promise never invokes constructor accessor and remains retained',async()=>{
 const owner=new RuntimeResourceShutdown(['actor']);let reads=0;const raw=Promise.resolve(exited);
 Object.defineProperty(raw,'constructor',{get(){reads++;return Promise;}});
 owner.register('actor',hooks({close:()=>raw}));owner.sealReady();
 expect((await owner.close(policy)).outcome).toBe('uncertain');expect(reads).toBe(0);expect(owner.retained.get('close-source:actor')).toBe(raw);
});

test('malformed receipt retains the original false value and never proves shutdown',async()=>{
 const owner=new RuntimeResourceShutdown(['actor']);owner.register('actor',hooks({close:(()=>false) as any}));owner.sealReady();
 expect((await owner.close(policy)).outcome).toBe('uncertain');expect(owner.retained.get('close-source:actor')).toBe(false);
});

test('captured cleanup receiver and method remain original despite later capability mutation',async()=>{
 const owner=new RuntimeResourceShutdown(['actor']);let receiver:unknown;const original=hooks({close:async function(){receiver=this;return exited;}});
 owner.register('actor',original);(original as any).close=()=>{throw Error('replaced');};owner.sealReady();
 expect((await owner.close(policy)).exited).toBe(true);expect(receiver).toBe(original);
});
