/*
 * TypeScript definitions for the zym-js bridge. The implementation lives in
 * zym.mjs; these are the types users consume.
 */

export type ZymStatusCode = 0 | 1 | 2 | 3 | 100;
export type ZymKindCode   = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 255;

export interface ZymErrorDetail {
    status: ZymStatusCode;
    file: string;
    line: number;
    message: string;
}

/** Thrown from VM operations on compile / runtime / bridge failure. */
export class ZymError extends Error {
    name: "ZymError";
    status: ZymStatusCode;
    details: ZymErrorDetail[];
}

/**
 * Opaque wrapper around a Zym value. Returned by native callbacks as their
 * arguments, and by operations that leave the value type unknown (structs,
 * enums, closures). Use `.toJS()` to decode, or `.kind` to inspect the type.
 *
 * Lifetime: accessing a `ZymValue` after its owning `VM` has been freed
 * (explicitly or via GC) throws a `ZymError` (`"ZymValue used after its VM
 * was freed"`) rather than reading freed wasm memory.
 */
export class ZymValue {
    readonly handle: number;
    readonly kind: ZymKindCode;
    isNull():     boolean;
    isBool():     boolean;
    isNumber():   boolean;
    isString():   boolean;
    isList():     boolean;
    isMap():      boolean;
    isCallable(): boolean;
    /**
     * Decode into a natural JS value:
     *   null / bool / number / string -> JS primitive
     *   list                          -> Array (recursive)
     *   map                           -> plain Object (recursive)
     *   struct                        -> plain Object with a non-enumerable
     *                                    `__type` string carrying the
     *                                    declared type name
     *   enum variant                  -> { __enum, name, ordinal } (frozen)
     *   function / closure            -> a callable JS function; invoking it
     *                                    calls back into the VM. The callable
     *                                    owns its own handle and exposes
     *                                    `.free()` / `[Symbol.dispose]` for
     *                                    deterministic cleanup (otherwise GC
     *                                    releases it).
     *   continuation / unknown        -> the ZymValue wrapper unchanged
     * Cycles in maps/structs are preserved via shared references.
     */
    toJS():       unknown;
    /** Format using the VM's display rules (same output as a Zym `print`). */
    display():    string;
    toString():   string;
    /**
     * JSON representation; auto-invoked by `JSON.stringify`. Returns the
     * same plain JS value as `toJS()`, so stringifying a ZymValue is safe.
     */
    toJSON():     unknown;
    /** Release the underlying handle eagerly. Optional; GC handles it otherwise. */
    dispose():    void;
    /** `using`-syntax support (Node 20.11+ / modern browsers). */
    [Symbol.dispose]?(): void;
}

/**
 * Any JS value that can cross into Zym. `undefined` maps to null.
 */
export type Marshalable =
    | null | undefined | boolean | number | bigint | string
    | Marshalable[]
    | { [k: string]: Marshalable }
    | ZymValue;

/**
 * A JS function callable from Zym. Receives wrapped args; may return
 * anything marshalable.
 *
 * If the function throws, the exception is converted to a Zym runtime
 * error with the thrown value's message. The script aborts and the
 * enclosing `vm.run()` / `vm.call()` rethrows it as a `ZymError` whose
 * `.details` carries the original JS message (source file `"<js>"`).
 */
export type NativeFn = (...args: ZymValue[]) => Marshalable;

export interface CompileOptions {
    file?: string;
    includeLineInfo?: boolean;
}

export interface SerializeOptions {
    includeLineInfo?: boolean;
}

/** Opaque compiled program. Save with `vm.serialize(chunk)`. */
export class Chunk {
    run(): void;
    /** Free the chunk's memory. Optional; GC handles it otherwise. */
    free(): void;
    /** `using`-syntax support (Node 20.11+ / modern browsers). */
    [Symbol.dispose]?(): void;
    /** Safe JSON form; auto-invoked by `JSON.stringify`. */
    toJSON(): { type: "ZymChunk"; alive: boolean };
}

export interface VM {
    /**
     * Destroy the VM and everything it owns. Safe to call multiple times.
     * If forgotten, the JS GC eventually reclaims the VM via a
     * FinalizationRegistry; call explicitly for deterministic cleanup.
     */
    free(): void;
    /** `using`-syntax support (Node 20.11+ / modern browsers). */
    [Symbol.dispose]?(): void;
    /** Safe JSON form; auto-invoked by `JSON.stringify`. */
    toJSON(): { type: "ZymVM"; alive: boolean };

    /** Subscribe to compile/runtime errors. Returns an unsubscribe function. */
    on(event: "error", listener: (err: ZymErrorDetail) => void): () => void;

    /** Compile source to a Chunk. Throws ZymError on failure. */
    compile(source: string, options?: CompileOptions): Chunk;

    /** Compile and execute source. Throws ZymError on failure. */
    run(source: string, options?: CompileOptions): void;

    /** Serialize a Chunk to bytecode. */
    serialize(chunk: Chunk, options?: SerializeOptions): Uint8Array;

    /** Load bytecode produced by `serialize`. */
    loadBytecode(bytes: Uint8Array | ArrayBuffer): Chunk;

    /**
     * Register a JS function as a Zym native.
     * @example vm.registerNative("greet(name)", (name) => `hi, ${name.toJS()}`);
     * @example vm.registerNative("log(level, ...)", (level, ...rest) => { ... });
     */
    registerNative(signature: string, fn: NativeFn): void;

    /** Define a global variable readable from Zym code. */
    defineGlobal(name: string, value: Marshalable): void;

    /** Invoke a Zym script function and return its result. */
    call(funcName: string, ...args: Marshalable[]): unknown;

    /**
     * Invoke an arbitrary callable value (function / closure) held by a
     * `ZymValue` wrapper or raw handle. This is the substrate behind the
     * callable returned from `ZymValue.toJS()`; most code should use the
     * callable directly and only reach for `callValue` when it already has
     * an opaque `ZymValue`.
     */
    callValue(callable: ZymValue | number, args?: Marshalable[]): unknown;
}

/**
 * Callable JS wrapper returned by `toJS()` for a Zym function/closure.
 * Invoking it calls back into the VM; `free()` / `[Symbol.dispose]` release
 * the underlying handle eagerly (otherwise GC handles it).
 */
export interface ZymCallable {
    (...args: Marshalable[]): unknown;
    free(): void;
    dispose(): void;
    [Symbol.dispose]?(): void;
    readonly __zymCallable: true;
}

export interface ZymFactory {
    /** Create a new isolated VM. */
    newVM(): VM;
    /** The zym-js version baked into the wasm. */
    version(): string;
}

export interface CreateZymOptions {
    [key: string]: unknown;
}

/**
 * Advanced factory: loads a fresh wasm module and returns a factory bound
 * to it. Prefer the default `Zym` export below for the common case; use
 * this only when you need isolated wasm instances or custom Emscripten
 * options.
 */
export function createZym(options?: CreateZymOptions): Promise<ZymFactory>;

/**
 * Lazy singleton entry point -- hides the wasm load behind the first
 * `newVM()` call and caches the shared module for every subsequent VM.
 *
 *     import Zym from "@zym-lang/zym-js";
 *     const vm = await Zym.newVM();
 *     vm.registerNative("print(a)", (a) => { console.log(a.toJS()); });
 *     vm.run(`print("hi");`);
 *     vm.free();
 */
export const Zym: Readonly<{
    /** Create a fresh VM, loading the shared wasm module on first call. */
    newVM(options?: CreateZymOptions): Promise<VM>;
    /** Version identifier baked into the wasm. */
    version(options?: CreateZymOptions): Promise<string>;
    /** Eagerly initialize the shared wasm module. */
    ready(options?: CreateZymOptions): Promise<void>;
}>;

export default Zym;

/** Numeric tags mirrored from src/zym_js_api.h (advanced use). */
export const KIND: Readonly<{
    NULL: 0; BOOL: 1; NUMBER: 2; STRING: 3;
    LIST: 4; MAP: 5; STRUCT: 6; ENUM: 7;
    FUNCTION: 8; CLOSURE: 9; PROMPT_TAG: 10; CONTINUATION: 11;
    UNKNOWN: 255;
}>;

/** Status-code tags mirrored from src/zym_js_api.h (advanced use). */
export const STATUS: Readonly<{
    OK: 0; COMPILE_ERROR: 1; RUNTIME_ERROR: 2; YIELD: 3; BRIDGE_ERROR: 100;
}>;
