import {types} from 'node:util';
import {shutdownResult,type ShutdownResult} from './shutdown.js';
const nativePromise=Promise;
const nativePromisePrototype=Promise.prototype;
const nativePromiseSpecies=Object.getOwnPropertyDescriptor(Promise,Symbol.species)?.get;
/** Admission and settlement observation for callbacks owned by one runtime.
 * This is quiescence only; it never proves transport, database or writer exit.
 * Only ordinary native Promises and non-thenable data can cross this boundary.
 * Unsupported raw returns remain owned evidence and permanently UNKNOWN. */
export class RuntimeOperationFence {
 private pinned=false;
 private uncertain=false;
 private ordinaryHistory=false;
 private readonly active=new Map<object,unknown>();
 get isPinned():boolean{return this.pinned;}
 get inFlight():number{return this.active.size;}
 assertAdmission():void{if(this.pinned)throw new Error('RUNTIME_NONFORCING_PINNED');}
 pinNonforcingShutdown():true{this.pinned=true;this.uncertain ||= this.ordinaryHistory;return true;}
 markOrdinaryClose():void{this.ordinaryHistory=true;if(this.pinned)this.uncertain=true;}
 invalidateObservation():void{this.uncertain=true;}
 observeNonforcingExit():ShutdownResult{
  if(!this.pinned || this.uncertain)return shutdownResult('uncertain');
  return this.active.size ? shutdownResult('timeout',this.active.size) : shutdownResult('exited');
 }
 private safeValue(value:unknown,allowPromise:boolean):boolean {
  if(value===null || (typeof value!=='object' && typeof value!=='function'))return true;
  // Inspecting a Proxy can delegate traps even after pin; reject by native brand.
  if(types.isProxy(value))return false;
  if(types.isPromise(value)) {
   if(!allowPromise || Object.getPrototypeOf(value)!==nativePromisePrototype ||
      Object.getOwnPropertyDescriptor(value,'constructor') || Object.getOwnPropertyDescriptor(value,'then'))return false;
   const constructor=Object.getOwnPropertyDescriptor(nativePromisePrototype,'constructor');
   const then=Object.getOwnPropertyDescriptor(nativePromisePrototype,'then');
   const species=Object.getOwnPropertyDescriptor(nativePromise,Symbol.species);
   return constructor?.value===nativePromise && then?.value===nativeThen &&
    !!species && species.get===nativePromiseSpecies && !species.set && !Object.hasOwn(species,'value');
  }
  let current:object|null=value;
  for(let depth=0;current && depth<16;depth++) {
   if(types.isProxy(current))return false;
   const then=Object.getOwnPropertyDescriptor(current,'then');
   if(then)return Object.hasOwn(then,'value') && typeof then.value!=='function';
   current=Object.getPrototypeOf(current);
  }
  return current===null;
 }
 async run<T>(operation:()=>T|Promise<T>):Promise<T>{
  this.assertAdmission();const token={};this.active.set(token,undefined);
  let retain=false;
  try{
   // Register ownership before a callback can synchronously reenter the pin.
   const value=Reflect.apply(operation,undefined,[]);this.active.set(token,value);
   if(!this.safeValue(value,true)){retain=true;this.uncertain=true;throw new Error('RUNTIME_OPERATION_RESULT_UNCONFIRMED');}
   const result=await value;
   if(!this.safeValue(result,false)){retain=true;this.uncertain=true;throw new Error('RUNTIME_OPERATION_RESULT_UNCONFIRMED');}
   return result;
  }finally{if(!retain)this.active.delete(token);}
 }
}
const nativeThen=Promise.prototype.then;
