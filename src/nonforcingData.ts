/** Copy callback data before it can execute an accessor inside a state mutation.
 * Descriptor traps may themselves pin; stop inspecting immediately afterward.
 * Bounds constrain inspection, independently of retained result byte limits. */
export function snapshotNonforcingData<T>(value: T, pinned: () => boolean):
  {ok: true; value: T} | {ok: false} {
  const ancestors = new Set<object>();
  let remaining = 65_536;
  function copy(input: unknown, depth: number): unknown {
    if (pinned() || --remaining < 0 || depth > 64) throw new Error("STATE_CALLBACK_DATA_UNCONFIRMED");
    if (input === null || input === undefined || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || ancestors.has(input)) throw new Error("STATE_CALLBACK_DATA_UNCONFIRMED");
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const length = Object.getOwnPropertyDescriptor(input,"length");
        if (pinned() || !length || !Object.hasOwn(length,"value") || !Number.isSafeInteger(length.value) ||
            length.value < 0 || length.value > 65_536) throw new Error("STATE_CALLBACK_DATA_UNCONFIRMED");
        const result: unknown[] = [];
        for (let index = 0; index < length.value; index++) {
          if (pinned()) throw new Error("STATE_CALLBACK_DATA_UNCONFIRMED");
          const field = Object.getOwnPropertyDescriptor(input,String(index));
          if (pinned() || !field || !Object.hasOwn(field,"value")) throw new Error("STATE_CALLBACK_DATA_UNCONFIRMED");
          result.push(copy(field.value,depth+1));
        }
        return result;
      }
      const keys = Object.getOwnPropertyNames(input);
      if (pinned() || keys.length > remaining) throw new Error("STATE_CALLBACK_DATA_UNCONFIRMED");
      const result: Record<string,unknown> = {};
      for (const key of keys) {
        if (pinned()) throw new Error("STATE_CALLBACK_DATA_UNCONFIRMED");
        const field = Object.getOwnPropertyDescriptor(input,key);
        if (pinned() || !field || !Object.hasOwn(field,"value")) throw new Error("STATE_CALLBACK_DATA_UNCONFIRMED");
        Object.defineProperty(result,key,{value:copy(field.value,depth+1),enumerable:true,writable:true,configurable:true});
      }
      return result;
    } finally {ancestors.delete(input);}
  }
  try {return {ok:true,value:copy(value,0) as T};} catch {return {ok:false};}
}
