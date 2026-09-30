import { snapshotShutdownPolicy, validShutdownResult, type ShutdownResult } from "./shutdown.js";

/** Correlation on the existing authenticated local owner/control connection. */
export type ExecutionShutdownBinding = Readonly<{
  generation: string; ownerPid: number; controllerId: string;
  requestId: string; closeRequestId: string;
}>;
export type ExecutionShutdownRequest = ExecutionShutdownBinding & (
  | Readonly<{type:"close-nonforcing";policy:Readonly<{allowSigkillEscalation:false;graceMs:number}>}>
  | Readonly<{type:"observe-nonforcing"}>
);
export type ExecutionShutdownReceipt = ExecutionShutdownBinding & Readonly<{
  type:"shutdown-receipt";operation:ExecutionShutdownRequest["type"];result:ShutdownResult;
}>;
const bindingKeys=["generation","ownerPid","controllerId","requestId","closeRequestId"] as const;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function data(value:unknown,keys:readonly string[]):Record<string,unknown>|undefined {
  try {
    if(!value || typeof value!=="object")return;
    const descriptors=Object.getOwnPropertyDescriptors(value);
    if(Reflect.ownKeys(descriptors).length!==keys.length || keys.some(k=>
      !Object.hasOwn(descriptors,k) || !Object.hasOwn(descriptors[k],"value")))return;
    return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
  } catch {return;}
}
function binding(value:Record<string,unknown>):ExecutionShutdownBinding|undefined {
  if(!Number.isSafeInteger(value.ownerPid) || (value.ownerPid as number)<2 ||
    bindingKeys.filter(k=>k!=="ownerPid").some(k=>typeof value[k]!=="string" || !uuid.test(value[k] as string)))return;
  return Object.freeze(Object.fromEntries(bindingKeys.map(k=>[k,value[k]]))) as ExecutionShutdownBinding;
}
/** Strict data-only copy. Parsing alone grants no authority or process action. */
export function snapshotExecutionShutdownRequest(value:unknown):ExecutionShutdownRequest|undefined {
  try {
    if(!value || typeof value!=="object")return;
    const type=Object.getOwnPropertyDescriptor(value,"type");
    if(!type || !Object.hasOwn(type,"value") || !["close-nonforcing","observe-nonforcing"].includes(type.value))return;
    const raw=data(value,["type",...bindingKeys,...(type.value==="close-nonforcing"?["policy"]:[])]);
    const b=raw && binding(raw);if(!raw || !b || raw.type!==type.value)return;
    if(raw.type==="observe-nonforcing") {
      if(b.requestId===b.closeRequestId)return;
      return Object.freeze({...b,type:"observe-nonforcing"});
    }
    if(b.requestId!==b.closeRequestId)return;
    const p=snapshotShutdownPolicy(raw.policy as never);
    if(p.allowSigkillEscalation!==false)return;
    return Object.freeze({...b,type:"close-nonforcing",policy:Object.freeze({allowSigkillEscalation:false,graceMs:p.graceMs})});
  } catch {return;}
}
/** A receipt must match the expected current owner/control/request and operation. */
export function snapshotExecutionShutdownReceipt(value:unknown,expected:ExecutionShutdownRequest):ExecutionShutdownReceipt|undefined {
  const request=snapshotExecutionShutdownRequest(expected);
  const raw=data(value,["type","operation",...bindingKeys,"result"]);
  const b=raw && binding(raw);
  if(!request || !raw || !b || raw.type!=="shutdown-receipt" || raw.operation!==request.type ||
    bindingKeys.some(k=>b[k]!==request[k]))return;
  const result=data(raw.result,["exited","outcome","survivors","signalFailures","identityChanges"]);
  if(!result || !validShutdownResult(result))return;
  return Object.freeze({...b,type:"shutdown-receipt",operation:request.type,result:Object.freeze(result) as ShutdownResult});
}
