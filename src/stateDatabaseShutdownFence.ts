import type Database from "better-sqlite3";
import {shutdownResult,type ShutdownResult} from "./shutdown.js";

/** A fence on one owned connection, including previously prepared statements.
 * Resource closure deliberately leaves durable writer retirement to its owner. */
export class StateDatabaseShutdownFence {
  readonly database: Database.Database;
  private pinned = false;
  private uncertain = false;
  private ordinaryClosed = false;
  private nativeCalls = 0;
  private asyncCalls = 0;
  private readonly iterators = new Set<object>();
  private closeAttempted = false;
  private closeConfirmed = false;
  private readonly capturedClose: () => void;
  private readonly wrapped = new WeakMap<object,object>();
  private readonly nativeHandleSymbols = new Map<symbol,object>();

  constructor(private readonly owned: Database.Database) {
    const close = owned.close;
    this.capturedClose = () => Reflect.apply(close,owned,[]);
    for (const key of Object.getOwnPropertySymbols(owned)) {
      const field = Object.getOwnPropertyDescriptor(owned,key);
      if (field && Object.hasOwn(field,"value") && field.value && typeof field.value === "object")
        this.nativeHandleSymbols.set(key,this.wrap(field.value,"native-handle"));
    }
    this.database = this.wrap(owned,"database") as Database.Database;
  }

  pinNonforcingShutdown(): true {
    if (!this.pinned) {
      this.pinned = true;
      this.uncertain ||= this.ordinaryClosed || this.nativeCalls > 0 || this.asyncCalls > 0 || this.owned.inTransaction;
    }
    return true;
  }

  observeNonforcingExit(): ShutdownResult {
    if (!this.pinned || this.uncertain) return shutdownResult("uncertain");
    if (this.nativeCalls + this.asyncCalls + this.iterators.size > 0)
      return shutdownResult("timeout",this.nativeCalls + this.asyncCalls + this.iterators.size);
    return this.closeConfirmed && !this.owned.open ? shutdownResult("exited") : shutdownResult("timeout",1);
  }

  /** Caller must establish enclosing actor/front-end quiescence separately. */
  closeNonforcing(): ShutdownResult {
    if (!this.pinned || this.uncertain) return shutdownResult("uncertain");
    if (this.nativeCalls + this.asyncCalls + this.iterators.size > 0 || this.owned.inTransaction)
      return shutdownResult("timeout",1);
    if (!this.closeAttempted) {
      this.closeAttempted = true;
      try {
        this.capturedClose();
        this.closeConfirmed = !this.owned.open;
        if (!this.closeConfirmed) this.uncertain = true;
      } catch {this.uncertain = true;}
    }
    return this.observeNonforcingExit();
  }

  private assertOpen(): void {
    if (this.pinned) throw new Error("STATE_DATABASE_NONFORCING_PINNED");
  }

  private wrap(value: object, kind: "database" | "statement" | "transaction" | "iterator" | "native-handle"): object {
    const previous = this.wrapped.get(value);
    if (previous) return previous;
    const fence = this;
    const methods = new Map<PropertyKey,unknown>();
    const facade = typeof value === "function" ? function() {} : Object.create(Object.getPrototypeOf(value));
    const proxy = new Proxy(facade, {
      get(target,key) {
        const native = typeof key === "symbol" ? fence.nativeHandleSymbols.get(key) : undefined;
        if (native) return native;
        // A borrowed native prototype sees only a guarded basic handle. Native
        // async/extension internals are never leaked through this compatibility path.
        if (kind === "native-handle" && !["prepare","exec","close","defaultSafeIntegers","unsafeMode",
          "name","open","inTransaction","readonly","memory"].includes(String(key))) {
          fence.assertOpen();
          throw new Error("STATE_DATABASE_NATIVE_HANDLE_UNAVAILABLE");
        }
        // No caller can recover the unguarded native connection from a handle.
        if (key === "database") return fence.database;
        if (methods.has(key)) return methods.get(key);
        const result = Reflect.get(value,key,value);
        if (typeof result !== "function") return result;
        if (kind === "transaction" && ["default","deferred","immediate","exclusive"].includes(String(key)))
          return fence.wrap(result,"transaction");
        const method = function(this: unknown,...args: unknown[]) {
          return fence.invoke(value,kind,key,result,args,kind === "transaction" &&
            key !== "call" && key !== "apply" && key !== "bind" ? this : value);
        };
        methods.set(key,method);
        return method;
      },
      apply(target,receiver,args) {
        return fence.invoke(value,"transaction","execute",value as (...args: unknown[]) => unknown,args,receiver);
      }
    });
    this.wrapped.set(value,proxy);
    return proxy;
  }

  private invoke(target: object,kind: string,key: PropertyKey,
    operation: (...args: unknown[]) => unknown,args: unknown[],receiver: unknown = target): unknown {
    // A prepared abort used by a borrowed native transaction may still unwind.
    // An already admitted native COMMIT can finish; pinning then stays UNKNOWN.
    const rollback = this.owned.inTransaction && (
      ((kind === "database" || kind === "native-handle") && key === "exec" && args.length === 1 && args[0] === "ROLLBACK") ||
      (kind === "statement" && key === "run" && args.length === 0 &&
        Reflect.get(target,"source",target) === "ROLLBACK"));
    const iteratorReturn = kind === "iterator" && key === "return";
    if (!rollback && !iteratorReturn) this.assertOpen();
    if ((kind === "database" || kind === "native-handle") && key === "close") this.ordinaryClosed = true;
    if (kind === "database" && key === "transaction") {
      const callback = args[0];
      if (typeof callback !== "function") throw new Error("STATE_TRANSACTION_CALLBACK_INVALID");
      args = [function(this: unknown,...values: unknown[]) {
        fence.assertOpen();
        const result = Reflect.apply(callback,this,values);
        fence.assertOpen();
        return result;
      },...args.slice(1)];
    }
    const fence = this;
    this.nativeCalls++;
    let result: unknown;
    try {result = Reflect.apply(operation,receiver,args);}
    catch (error) {
      if (this.pinned && (rollback || iteratorReturn)) this.uncertain = true;
      throw error;
    }
    finally {this.nativeCalls--;}
    if (result === this.owned) return this.database;
    if ((kind === "database" || kind === "native-handle") && key === "prepare" && result && typeof result === "object")
      return this.wrap(result,"statement");
    if (kind === "database" && key === "transaction" && typeof result === "function")
      return this.wrap(result,"transaction");
    if (kind === "transaction" && typeof result === "function") return this.wrap(result,"transaction");
    if (kind === "statement" && key === "iterate" && result && typeof result === "object") {
      this.iterators.add(result);
      return this.wrap(result,"iterator");
    }
    if (kind === "statement" && result === target) return this.wrap(target,"statement");
    if (kind === "iterator" && result && typeof result === "object" &&
        ((result as IteratorResult<unknown>).done === true || iteratorReturn)) this.iterators.delete(target);
    if (kind === "iterator" && key === Symbol.iterator) return this.wrap(target,"iterator");
    if (result instanceof Promise) {
      this.asyncCalls++;
      void result.then(()=>{this.asyncCalls--;},()=>{this.asyncCalls--;});
    }
    return result;
  }
}
