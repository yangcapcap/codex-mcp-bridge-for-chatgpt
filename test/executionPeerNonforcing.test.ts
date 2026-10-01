import {EventEmitter} from "node:events";
import {afterEach,beforeEach,describe,expect,test,vi} from "vitest";
const h=vi.hoisted(()=>({sockets:[] as any[],children:[] as any[],signals:[] as string[]}));
vi.mock("node:net",async original=>({...await original<any>(),createConnection:()=>{
 const socket=new EventEmitter() as any;socket.destroyed=false;socket.writableLength=0;
 socket.write=vi.fn((_data:Buffer,done?:()=>void)=>{done?.();return true;});
 socket.destroy=()=>{socket.destroyed=true;socket.emit("close");return socket;};h.sockets.push(socket);return socket;
}}));
vi.mock("node:child_process",async original=>({...await original<any>(),spawn:()=>{
 const child=new EventEmitter() as any;child.pid=51000+h.children.length;child.exitCode=null;child.signalCode=null;
 child.stderr=new EventEmitter();child.stderr.unref=()=>{};child.unref=()=>{};
 child.kill=vi.fn((signal:string)=>{h.signals.push(signal);return true;});h.children.push(child);return child;
}}));
import {ExecutionPeer} from "../src/executionTransport.js";
const generation="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function peer(){return new ExecutionPeer({directory:"/private/task-only-no-files-created",token:"synthetic"},{args:[],env:{},onStderr(){}});}
function authenticate(socket:any,pid=51000,gen=generation){const body=Buffer.from(JSON.stringify({type:"owner",pid,generation:gen}));const header=Buffer.alloc(4);header.writeUInt32BE(body.length);socket.emit("data",Buffer.concat([header,body]));}
beforeEach(()=>{vi.useFakeTimers();h.sockets=[];h.children=[];h.signals=[];});afterEach(()=>vi.useRealTimers());
describe("retained execution peer nonforcing signal and launch fence",()=>{
 test.each(["toJSON","accessor","inherited"])("retains prior serialized %s ordinary close history",async variant=>{
  const p=peer();p.start();h.sockets[0].destroy();await vi.advanceTimersByTimeAsync(250);authenticate(h.sockets[1]);
  const message=variant==="accessor" ? Object.defineProperty({},"type",{enumerable:true,get:()=>"close"}) :
   variant==="inherited" ? Object.assign(Object.create({type:"request"}),{toJSON:()=>({type:"close"})}) : {toJSON:()=>({type:"close"})};
  expect(p.send(message)).toBe(true);
  const frame=h.sockets[1].write.mock.calls.at(-1)[0] as Buffer;
  expect(JSON.parse(frame.subarray(4).toString())).toEqual({type:"close"});p.pinNonforcingShutdown();
  h.children[0].exitCode=0;h.children[0].emit("exit",0,null);
  expect(p.observeNonforcingExit().outcome).toBe("uncertain");p.detach();
 });
 test("queued wire bytes cannot become force control after caller mutation",async()=>{
  const p=peer();p.start();h.sockets[0].destroy();await vi.advanceTimersByTimeAsync(250);authenticate(h.sockets[1]);
  let firstDone:(()=>void)|undefined;
  h.sockets[1].write.mockImplementationOnce((_data:Buffer,done:()=>void)=>{firstDone=done;return true;});
  expect(p.send({type:"request",id:1})).toBe(true);
  const queued:any={type:"request",id:2};expect(p.send(queued)).toBe(true);
  queued.type="terminate-owner";queued.signal="SIGKILL";firstDone!();
  const frame=h.sockets[1].write.mock.calls.at(-1)[0] as Buffer;
  expect(JSON.parse(frame.subarray(4).toString())).toEqual({type:"request",id:2});p.pinNonforcingShutdown();
  h.children[0].exitCode=0;h.children[0].emit("exit",0,null);expect(p.observeNonforcingExit().exited).toBe(true);p.detach();
 });
 test("ordinary serialization occurs once for the exact transmitted representation",async()=>{
  const p=peer();p.start();h.sockets[0].destroy();await vi.advanceTimersByTimeAsync(250);authenticate(h.sockets[1]);
  let calls=0;expect(p.send({toJSON:()=>++calls===1?{type:"request"}:{type:"terminate-owner",signal:"SIGKILL"}})).toBe(true);
  expect(calls).toBe(1);const frame=h.sockets[1].write.mock.calls.at(-1)[0] as Buffer;
  expect(JSON.parse(frame.subarray(4).toString())).toEqual({type:"request"});p.detach();
 });
 test("serialization that reentrantly pins cannot enqueue ordinary close afterward",async()=>{
  const p=peer();p.start();h.sockets[0].destroy();await vi.advanceTimersByTimeAsync(250);authenticate(h.sockets[1]);
  const done=vi.fn();expect(p.send({toJSON(){p.pinNonforcingShutdown();return {type:"close"};}},done)).toBe(false);
  expect(done).toHaveBeenCalledWith(expect.any(Error));expect(h.sockets[1].write).not.toHaveBeenCalled();p.detach();
 });
 test("ordinary owned child signals are preserved before pin",()=>{
  const p=peer();p.start();h.sockets[0].destroy();expect(h.children).toHaveLength(1);
  expect(p.kill("SIGKILL")).toBe(true);expect(h.signals).toEqual(["SIGKILL"]);p.detach();
 });
 test("pin before owner authentication prohibits a new launch and keeps exit unknown",async()=>{
  const p=peer();p.start();expect(p.pinNonforcingShutdown()).toBeUndefined();h.sockets[0].destroy();
  await vi.advanceTimersByTimeAsync(1000);p.start();expect(h.children).toHaveLength(0);
  expect(h.sockets).toHaveLength(1);expect(p.observeNonforcingExit().outcome).toBe("uncertain");expect(p.kill("SIGTERM")).toBe(false);p.detach();
 });
 test("a previously queued retry cannot launch after pin",async()=>{
  const p=peer();p.start();h.sockets[0].destroy();expect(h.children).toHaveLength(1);p.pinNonforcingShutdown();
  await vi.advanceTimersByTimeAsync(1000);expect(h.sockets).toHaveLength(1);expect(h.children).toHaveLength(1);
  expect(p.kill("SIGKILL")).toBe(false);expect(h.signals).toEqual([]);p.detach();
 });
 test("only measured exit of the retained owned handle can prove this peer exited",async()=>{
  const p=peer();p.start();h.sockets[0].destroy();await vi.advanceTimersByTimeAsync(250);authenticate(h.sockets[1]);
  const binding=p.pinNonforcingShutdown()!;expect(binding).toMatchObject({generation,ownerPid:51000});expect(Object.isFrozen(binding)).toBe(true);
  const old=p.observeNonforcingExit();expect(old).toMatchObject({outcome:"timeout",survivors:1});
  for(const signal of ["SIGKILL","SIGTERM","SIGINT","SIGSTOP"] as const)expect(p.kill(signal)).toBe(false);
  h.children[0].exitCode=0;h.children[0].emit("exit",0,null);
  expect(p.observeNonforcingExit().exited).toBe(true);expect(old.outcome).toBe("timeout");expect(h.signals).toEqual([]);
 });
 test("an authenticated reattached owner with no child handle remains unknown",()=>{
  const p=peer();p.start();authenticate(h.sockets[0],1234);expect(p.connected).toBe(true);
  expect(p.pinNonforcingShutdown()?.ownerPid).toBe(1234);expect(p.observeNonforcingExit().outcome).toBe("uncertain");
  expect(p.kill("SIGKILL")).toBe(false);expect(h.sockets[0].write).not.toHaveBeenCalled();p.detach();
 });
 test.each(["pid","generation"])("rejects another %s owner on reconnect without launching or signaling",async field=>{
  const p=peer();p.start();authenticate(h.sockets[0],1234);const retained=p.pinNonforcingShutdown()!;
  h.sockets[0].destroy();await vi.advanceTimersByTimeAsync(250);
  authenticate(h.sockets[1],field==="pid"?1235:1234,field==="generation"?"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":generation);
  expect(h.sockets[1].destroyed).toBe(true);expect(p.nonforcingBinding).toBeUndefined();
  expect(p.observeNonforcingExit().outcome).toBe("uncertain");expect(retained.ownerPid).toBe(1234);
  await vi.advanceTimersByTimeAsync(1000);expect(h.sockets).toHaveLength(2);expect(h.children).toHaveLength(0);expect(h.signals).toEqual([]);p.detach();
 });
 test("same-owner reconnection retains the original controller correlation",async()=>{
  const p=peer();p.start();authenticate(h.sockets[0],1234);const binding=p.pinNonforcingShutdown()!;
  h.sockets[0].destroy();await vi.advanceTimersByTimeAsync(250);authenticate(h.sockets[1],1234);
  expect(p.connected).toBe(true);expect(p.nonforcingBinding).toEqual(binding);expect(h.children).toHaveLength(0);p.detach();
 });
 test("prior ordinary force history remains unknown after real owned-handle exit",async()=>{
  const p=peer();p.start();h.sockets[0].destroy();await vi.advanceTimersByTimeAsync(250);authenticate(h.sockets[1]);
  p.kill("SIGKILL");p.pinNonforcingShutdown();h.children[0].exitCode=0;h.children[0].emit("exit",0,null);
  expect(p.observeNonforcingExit().outcome).toBe("uncertain");expect(h.signals).toEqual(["SIGKILL"]);
 });
 test("generic send cannot bypass the sticky signal fence with ordinary owner controls",()=>{
  const p=peer();p.start();authenticate(h.sockets[0],1234);p.pinNonforcingShutdown();const denied=vi.fn();
  for(const message of [{type:"close"},{type:"terminate-owner",signal:"SIGKILL"},{type:"request",operation:"callTool"}])
    expect(p.send(message,denied)).toBe(false);
  expect(denied).toHaveBeenCalledTimes(3);expect(h.sockets[0].write).not.toHaveBeenCalled();p.detach();
 });
 test("only bound immutable close/observation frames cross the pinned link",()=>{
  const p=peer();p.start();authenticate(h.sockets[0],1234);const binding=p.pinNonforcingShutdown()!;
  const id="11111111-1111-4111-8111-111111111111",next="22222222-2222-4222-8222-222222222222";
  const close={...binding,type:"close-nonforcing",requestId:id,closeRequestId:id,policy:{allowSigkillEscalation:false,graceMs:7}};
  expect(p.send({...close,ownerPid:1235})).toBe(false);expect(p.send(close)).toBe(true);
  expect(p.send({...close,requestId:next,closeRequestId:next})).toBe(false);
  expect(p.send({...close,policy:{allowSigkillEscalation:false,graceMs:99}})).toBe(false);
  close.policy.graceMs=99;
  const {policy,...fields}=close;expect(p.send({...fields,type:"observe-nonforcing",requestId:next})).toBe(true);
  expect(p.send({...fields,type:"observe-nonforcing",requestId:next,closeRequestId:next})).toBe(false);
  expect(h.sockets[0].write).toHaveBeenCalledTimes(2);p.detach();
 });
 test("observation without a sent close request proves nothing and does not cross the link",()=>{
  const p=peer();p.start();authenticate(h.sockets[0],1234);const binding=p.pinNonforcingShutdown()!;
  expect(p.send({...binding,type:"observe-nonforcing",requestId:"22222222-2222-4222-8222-222222222222",closeRequestId:"11111111-1111-4111-8111-111111111111"})).toBe(false);
  expect(h.sockets[0].write).not.toHaveBeenCalled();p.detach();
 });
 test("changed owned handle PID cannot satisfy the retained owner correlation",async()=>{
  const p=peer();p.start();h.sockets[0].destroy();await vi.advanceTimersByTimeAsync(250);authenticate(h.sockets[1]);p.pinNonforcingShutdown();
  h.children[0].pid=51001;h.children[0].exitCode=0;expect(p.observeNonforcingExit().outcome).toBe("uncertain");p.detach();
 });
});
