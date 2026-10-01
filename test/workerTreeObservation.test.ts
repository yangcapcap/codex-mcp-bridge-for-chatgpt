import {describe,expect,test,vi} from "vitest";
import {SupervisedProcessTreeRegistry} from "../src/processTreeSupervisor.js";
const first={pid:990001,processGroupId:990001};
const second={pid:990011,processGroupId:990011};
const row=(pid:number,parentPid:number,processGroupId:number)=>({pid,parentPid,processGroupId,state:"S",startedAt:`birth ${pid}`});
function fixture(){
 let rows=[row(first.pid,1,first.pid),row(990002,first.pid,990002),row(second.pid,1,second.pid),row(990012,second.pid,990012)];
 const registry=new SupervisedProcessTreeRegistry(async()=>rows);
 return {registry,setRows:(value:typeof rows)=>{rows=value;}};
}
describe.skipIf(process.platform==="win32")("scoped retained worker tree observations",()=>{
 test.each(["remember","pin"])("a reentrant selector cannot %s a newly eligible tree after invocation",async action=>{
  const registry=new SupervisedProcessTreeRegistry(async()=>[]);
  if(action==="remember")registry.pinNonforcingShutdown();else{registry.remember(first,true);registry.markExited(first);}
  const input=new Proxy({...first},{ownKeys(target){
   if(action==="remember"){registry.remember(first,true);registry.markExited(first);}else registry.pinNonforcingShutdown();
   return Reflect.ownKeys(target);
  }});
  expect((await registry.observeNonforcingTreeExit(input)).outcome).toBe("uncertain");
  expect((await registry.observeNonforcingTreeExit(first)).exited).toBe(true);
 });
 test("separate workers report their own survivors without copying away registry history",async()=>{
  const f=fixture();await f.registry.register(first);await f.registry.register(second);f.registry.pinNonforcingShutdown();
  expect((await f.registry.observeNonforcingTreeExit(first)).survivors).toBe(2);
  expect((await f.registry.observeNonforcingTreeExit(second)).survivors).toBe(2);
  expect((await f.registry.observeNonforcingExit()).survivors).toBe(4);expect(f.registry.size).toBe(2);
  f.registry.markExited(first);f.setRows([row(second.pid,1,second.pid),row(990012,second.pid,990012)]);
  expect((await f.registry.observeNonforcingTreeExit(first)).exited).toBe(true);
  expect((await f.registry.observeNonforcingTreeExit(second)).survivors).toBe(2);
  expect((await f.registry.observeNonforcingExit()).exited).toBe(false);
 });
 test("absent exact roots and unrequested pin never grant empty-tree exit",async()=>{
  const f=fixture();await f.registry.register(first);
  expect((await f.registry.observeNonforcingTreeExit(first)).outcome).toBe("uncertain");f.registry.pinNonforcingShutdown();
  for(const identity of [second,{...first,processGroupId:null},{...first,processGroupId:990099}])
   expect((await f.registry.observeNonforcingTreeExit(identity)).outcome).toBe("uncertain");
 });
 test("an identity is copied synchronously before the observation queue can yield",async()=>{
  const f=fixture();await f.registry.register(first);await f.registry.register(second);f.registry.pinNonforcingShutdown();
  const supplied={...first};const observation=f.registry.observeNonforcingTreeExit(supplied);
  supplied.pid=second.pid;supplied.processGroupId=second.pid;
  f.registry.markExited(first);f.setRows([row(second.pid,1,second.pid)]);
  expect((await observation).exited).toBe(true);
 });
 test("registration after a missing-scope request cannot retroactively certify it",async()=>{
  const f=fixture();f.registry.pinNonforcingShutdown();const observation=f.registry.observeNonforcingTreeExit(first);
  f.registry.remember(first,true);f.registry.markExited(first);f.setRows([]);
  expect((await observation).outcome).toBe("uncertain");expect((await f.registry.observeNonforcingTreeExit(first)).exited).toBe(true);
 });
 test("strict own identity data denies accessors, inherited and extra fields without invoking getters",async()=>{
  const f=fixture();await f.registry.register(first);f.registry.pinNonforcingShutdown();const getter=vi.fn(()=>first.pid);
  const input=[Object.create(first),{...first,extra:true},{...first,[Symbol()]:true},Object.defineProperty({processGroupId:first.pid},"pid",{get:getter}),null,
   new Proxy({}, {ownKeys(){throw Error("fault");}})];
  for(const identity of input)expect((await f.registry.observeNonforcingTreeExit(identity as never)).outcome).toBe("uncertain");
  expect(getter).not.toHaveBeenCalled();
 });
 test("a retained escaped child prevents false scoped exit and the old result stays sealed",async()=>{
  const f=fixture();await f.registry.register(first);f.registry.pinNonforcingShutdown();f.registry.markExited(first);f.setRows([row(990002,1,990002)]);
  const old=await f.registry.observeNonforcingTreeExit(first);expect(old).toMatchObject({outcome:"timeout",survivors:1});
  f.registry.forget(first);f.setRows([]);expect((await f.registry.observeNonforcingTreeExit(first)).exited).toBe(true);
  expect(old.outcome).toBe("timeout");expect(f.registry.snapshots()[0].processes).toHaveLength(2);
 });
 test("prior active ordinary cleanup uncertainty cannot be cleared by selecting another worker",async()=>{
  const f=fixture();await f.registry.register(first);await f.registry.register(second);
  const signal=vi.spyOn(process,"kill").mockImplementation((_pid,kind)=>{if(kind==="SIGTERM")f.registry.pinNonforcingShutdown();return true;});
  try {expect(await f.registry.release(first,0)).toBe(false);f.registry.markExited(second);f.setRows([]);
   expect((await f.registry.observeNonforcingTreeExit(second)).outcome).toBe("uncertain");
   expect(signal.mock.calls.some(([,kind])=>kind==="SIGKILL")).toBe(false);
  }finally{signal.mockRestore();}
 });
 test("incomplete retained scope stays unknown after apparent absence",async()=>{
  const f=fixture();await f.registry.register(first);f.registry.pinNonforcingShutdown();
  f.registry.merge({root:first,processes:[],incomplete:true});f.registry.markExited(first);f.setRows([]);
  expect((await f.registry.observeNonforcingTreeExit(first)).outcome).toBe("uncertain");
 });
 test("unregistered birth and probe rejection cannot certify scoped exit",async()=>{
  const f=fixture();f.registry.remember(first,true);f.registry.pinNonforcingShutdown();f.setRows([]);
  expect((await f.registry.observeNonforcingTreeExit(first)).outcome).toBe("uncertain");
  const r=new SupervisedProcessTreeRegistry(async()=>{throw Error("probe fault");});r.remember(first,true);r.pinNonforcingShutdown();
  expect((await r.observeNonforcingTreeExit(first)).outcome).toBe("uncertain");
 });
 test("a late observation cannot rewrite its timed-out scoped result",async()=>{
  let finish!:(value:ReturnType<typeof row>[])=>void;
  const r=new SupervisedProcessTreeRegistry(()=>new Promise(resolve=>{finish=resolve;}));r.remember(first,true);r.markExited(first);r.pinNonforcingShutdown();
  const old=await r.observeNonforcingTreeExit(first,1);expect(old.outcome).toBe("uncertain");
  finish([]);await new Promise(resolve=>setTimeout(resolve,1));expect(old.outcome).toBe("uncertain");
 });
});
