import { describe,expect,test,vi } from "vitest";
import { snapshotExecutionShutdownRequest,snapshotExecutionShutdownReceipt,type ExecutionShutdownRequest } from "../src/executionShutdownProtocol.js";
import { shutdownResult } from "../src/shutdown.js";
const id="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222";
const request={type:"close-nonforcing",generation:id,ownerPid:20,controllerId:id,requestId:id,closeRequestId:id,policy:{allowSigkillEscalation:false,graceMs:7}} as const;
const receipt={type:"shutdown-receipt",operation:request.type,generation:id,ownerPid:20,controllerId:id,requestId:id,closeRequestId:id,result:shutdownResult("exited")};
describe("execution owner close correlation envelope",()=>{
 test("copies exact close and observation frames without granting exit or action",()=>{
  const close=snapshotExecutionShutdownRequest(request)!;expect(close).toEqual(request);expect(Object.isFrozen(close)).toBe(true);
  expect(Object.isFrozen(close.type==="close-nonforcing" && close.policy)).toBe(true);
  const observe=snapshotExecutionShutdownRequest({...request,type:"observe-nonforcing",requestId:other,policy:undefined});expect(observe).toBeUndefined();
  const {policy,...fields}=request;expect(snapshotExecutionShutdownRequest({...fields,type:"observe-nonforcing",requestId:other})).toEqual({...fields,type:"observe-nonforcing",requestId:other});
 });
 test.each(["generation","ownerPid","controllerId","requestId","closeRequestId"] as const)("rejects valid but unrelated %s receipt",field=>{
  expect(snapshotExecutionShutdownReceipt({...receipt,[field]:field==="ownerPid"?21:other},request)).toBeUndefined();
 });
 test("does not accept a close receipt for a fresh observation or rewrite retained evidence",()=>{
  const {policy,...fields}=request;const observe=snapshotExecutionShutdownRequest({...fields,type:"observe-nonforcing",requestId:other})!;
  expect(snapshotExecutionShutdownReceipt({...receipt,requestId:other},observe)).toBeUndefined();
  const timed={...receipt,result:shutdownResult("timeout",1)},retained=snapshotExecutionShutdownReceipt(timed,request)!;
  const fresh=snapshotExecutionShutdownReceipt({...receipt,operation:"observe-nonforcing",requestId:other},observe)!;
  expect(fresh.result.exited).toBe(true);expect(retained.result.outcome).toBe("timeout");
 });
 test.each([undefined,null,{},Object.create(request),{...request,extra:true},{...request,[Symbol("hidden")]:true},
  {...request,ownerPid:0},{...request,generation:"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}, {...request,generation:"old-owner"},
  {...request,policy:{allowSigkillEscalation:true}}, {...request,requestId:other},
  {...request,policy:{allowSigkillEscalation:false,graceMs:60001}}])("denies malformed close input %s",value=>{
  expect(snapshotExecutionShutdownRequest(value)).toBeUndefined();
 });
 test("rejects observation with reused close request ID",()=>{
  const {policy,...fields}=request;expect(snapshotExecutionShutdownRequest({...fields,type:"observe-nonforcing"})).toBeUndefined();
 });
 test.each([undefined,{},Object.create(receipt),{...receipt,extra:1},{...receipt,[Symbol("hidden")]:true},
  {...receipt,result:undefined},{...receipt,result:{...receipt.result,survivors:1}},
  {...receipt,result:{...receipt.result,extra:true}}])("denies malformed completion %s",value=>{
  expect(snapshotExecutionShutdownReceipt(value,request)).toBeUndefined();
 });
 test("copies receipt data without retaining a mutable caller result",()=>{
  const mutable={...receipt,result:{...receipt.result}},r=snapshotExecutionShutdownReceipt(mutable,request)!;
  mutable.result.exited=false;expect(r.result.exited).toBe(true);expect(Object.isFrozen(r)).toBe(true);expect(Object.isFrozen(r.result)).toBe(true);
 });
 test("does not invoke property getters in request, policy, receipt or result",()=>{
  const getter=vi.fn(()=>true);
  for(const key of ["type","ownerPid","policy"]){const value=Object.defineProperty({...request},key,{get:getter});expect(snapshotExecutionShutdownRequest(value)).toBeUndefined();}
  expect(snapshotExecutionShutdownRequest({...request,policy:Object.defineProperty({},"allowSigkillEscalation",{get:getter})})).toBeUndefined();
  for(const key of ["operation","generation","result"]){const value=Object.defineProperty({...receipt},key,{get:getter});expect(snapshotExecutionShutdownReceipt(value,request)).toBeUndefined();}
  expect(snapshotExecutionShutdownReceipt({...receipt,result:Object.defineProperty({...receipt.result},"exited",{get:getter})},request)).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
 });
 test("malformed expected request grants no matching receipt",()=>{
  expect(snapshotExecutionShutdownReceipt(receipt,{...request,policy:{allowSigkillEscalation:true}} as unknown as ExecutionShutdownRequest)).toBeUndefined();
 });
});
