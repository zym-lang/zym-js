/*
 * zym.mjs -- ergonomic JS wrapper around the zym-js wasm bridge.
 *
 * Minimal use:
 *
 *   import Zym from "./zym.mjs";
 *   const vm = await Zym.newVM();
 *   vm.registerNative("greet(name)", (name) => `hello, ${name}`);
 *   vm.run(`print(greet("world"));`);
 *   vm.free();
 *
 * `Zym.newVM()` lazily instantiates the underlying wasm module on first
 * call and caches it for every VM thereafter; users never see the module
 * boundary. For advanced cases (isolated wasm instances, custom
 * Emscripten options) the `createZym` factory is still exported:
 *
 *   import { createZym } from "./zym.mjs";
 *   const zym = await createZym({ locateFile: ... });
 *   const vm  = zym.newVM();
 *
 * Users never touch handle ids, roots, or ZymValue mechanics directly; the
 * wrapper marshals JS primitives to Zym values automatically and uses a
 * FinalizationRegistry to release anything it allocated when the JS GC
 * reclaims the wrapper object.
 */

import createZymModule from "../dist/zym_js.mjs";

// ---------------------------------------------------------------------------
// Numeric tags that mirror the #defines in src/zym_js_api.h. Kept out of the
// public API; users should test values through the wrapper methods instead.
// ---------------------------------------------------------------------------
const KIND = Object.freeze({
    NULL: 0, BOOL: 1, NUMBER: 2, STRING: 3,
    LIST: 4, MAP: 5, STRUCT: 6, ENUM: 7,
    FUNCTION: 8, CLOSURE: 9, PROMPT_TAG: 10, CONTINUATION: 11,
    UNKNOWN: 255,
});

const STATUS = Object.freeze({
    OK: 0, COMPILE_ERROR: 1, RUNTIME_ERROR: 2, YIELD: 3, BRIDGE_ERROR: 100,
});

// ---------------------------------------------------------------------------
// ZymError: thrown from vm.compile / vm.run when the underlying VM raises a
// compile or runtime error. Errors collected via the error callback are
// attached as `.details`.
// ---------------------------------------------------------------------------
export class ZymError extends Error {
    constructor(message, { status = STATUS.BRIDGE_ERROR, details = [] } = {}) {
        super(message);
        this.name = "ZymError";
        this.status = status;
        this.details = details;
    }
}

// ---------------------------------------------------------------------------
// Module-level finalizer for VM wrappers. If a user forgets to call
// `vm.free()` and drops all references, the JS GC eventually reclaims the
// wrapper and this finalizer runs, releasing the wasm VM, its callbacks,
// and its error-bus entries. The held value is intentionally a closure that
// captures ONLY primitives / non-wrapper references so the registry does
// not pin the wrapper object.
// ---------------------------------------------------------------------------
const _vmFinalizer = new FinalizationRegistry((cleanup) => {
    try { cleanup(); } catch (_) { /* swallow; finalizers must not throw */ }
});

// Finalizer for Chunk wrappers: frees the compiled chunk if the wrapper is
// dropped without `chunk.free()` (and the parent VM is still alive).
const _chunkFinalizer = new FinalizationRegistry((cleanup) => {
    try { cleanup(); } catch (_) { /* swallow */ }
});

// Finalizer for callable JS wrappers produced when `toJS()` decodes a Zym
// FUNCTION/CLOSURE. When the callable is GC'd, its underlying handle is
// released so the Zym GC can reclaim the function/closure.
const _callableFinalizer = new FinalizationRegistry((cleanup) => {
    try { cleanup(); } catch (_) { /* swallow */ }
});

// Define an own property that is not enumerable -- keeps wrapper internals
// out of JSON.stringify, structuredClone, and generic property walks (which
// would otherwise traverse `_vm -> Module -> HEAP*` and blow up).
function _hide(target, key, value) {
    Object.defineProperty(target, key, {
        value, writable: true, enumerable: false, configurable: true,
    });
}

// ---------------------------------------------------------------------------
// `createZym()` -- loads the wasm module and returns a small factory object.
// The underlying Emscripten module is created once per call; if you need
// strict isolation (e.g. separate wasm memories) call it again. Most users
// should prefer the default `Zym` export (see bottom of file) which shares
// a single cached wasm instance.
// ---------------------------------------------------------------------------
export async function createZym(options = {}) {
    const Module = await createZymModule(options);
    const bridge = new Bridge(Module);
    return {
        /** Create a fresh VM bound to this wasm module. */
        newVM: () => new VM(bridge),
        /** Build/version identification baked into the wasm. */
        version: () => Module.UTF8ToString(Module._zjs_version()),
    };
}

// ---------------------------------------------------------------------------
// Default export -- a process-wide lazy singleton that hides the wasm load
// behind the first `newVM()` call. The wasm module is created on demand and
// cached; subsequent VMs share it. For strict isolation or custom
// Emscripten options, reach for the named `createZym` factory instead.
// ---------------------------------------------------------------------------
let _defaultFactoryPromise = null;

function _ensureDefaultFactory(options) {
    if (!_defaultFactoryPromise) {
        _defaultFactoryPromise = createZym(options).catch((err) => {
            // Reset on failure so a later retry can succeed.
            _defaultFactoryPromise = null;
            throw err;
        });
    }
    return _defaultFactoryPromise;
}

const Zym = Object.freeze({
    /**
     * Create a fresh VM. The first call lazily loads the wasm module;
     * every subsequent call reuses the same module. `options` (if any) is
     * forwarded to the Emscripten factory on the first call only.
     */
    async newVM(options) {
        const factory = await _ensureDefaultFactory(options);
        return factory.newVM();
    },
    /** Build/version identification baked into the wasm. */
    async version(options) {
        const factory = await _ensureDefaultFactory(options);
        return factory.version();
    },
    /**
     * Eagerly initialize the shared wasm module (useful for absorbing the
     * one-time load cost behind a splash screen). Safe to call multiple
     * times; subsequent calls return the cached factory.
     */
    async ready(options) {
        await _ensureDefaultFactory(options);
    },
});

export default Zym;

// ---------------------------------------------------------------------------
// Bridge: thin layer over the raw Module exports, shared by every VM created
// from the same wasm instance. Owns the per-instance JS callback registry
// (used by the native-dispatch trampoline) and the error bus.
// ---------------------------------------------------------------------------
class Bridge {
    constructor(Module) {
        this.M = Module;
        this.nextCbId = 1;
        this.callbacks = new Map();        // cb_id -> { fn, vm }
        this.errorListeners = new Map();   // vm_ptr -> array of listeners
        this.pendingErrors = new Map();    // vm_ptr -> array of captured errors

        // Wire up the two entry points expected by the EM_JS stubs in
        // zym_js_api.c. These two members are the full JS-facing contract
        // between the shim and the wrapper.
        Module.__zjs_onError = (vmPtr, type, file, line, message) => {
            const entry = { status: type, file, line, message };
            const listeners = this.errorListeners.get(vmPtr);
            if (listeners && listeners.length > 0) {
                for (const l of listeners) {
                    try { l(entry); } catch (_) { /* swallow listener failure */ }
                }
            }
            let bucket = this.pendingErrors.get(vmPtr);
            if (!bucket) { bucket = []; this.pendingErrors.set(vmPtr, bucket); }
            bucket.push(entry);
        };

        Module.__zjs_nativeDispatch = (
            cbId, vmPtr, arity, argsPtr, isVariadic, vargsPtr, vargc, outIsErrorPtr,
        ) => {
            const entry = this.callbacks.get(cbId);
            if (!entry) {
                Module.HEAP32[outIsErrorPtr >> 2] = 1;
                return 0;
            }
            const vm = entry.vm;
            try {
                // Read arg handles out of wasm memory and wrap each one.
                const fixedArgs = readHandleArray(Module, argsPtr, arity).map((h) => vm._wrapBorrowed(h));
                let jsResult;
                if (isVariadic) {
                    const restArgs = readHandleArray(Module, vargsPtr, vargc).map((h) => vm._wrapBorrowed(h));
                    jsResult = entry.fn.apply(null, [...fixedArgs, ...restArgs]);
                } else {
                    jsResult = entry.fn.apply(null, fixedArgs);
                }
                // Marshal the JS return value back into a handle owned by C.
                const resultHandle = vm._marshalToHandle(jsResult, /*ownership*/ "transfer");
                return resultHandle;
            } catch (err) {
                // Report the exception as a Zym runtime error and surface
                // it through the error bus so callers of run()/callFunction()
                // get a meaningful message.
                Module.HEAP32[outIsErrorPtr >> 2] = 1;
                const msg = err && err.message ? String(err.message) : String(err);
                // Stash the message on the C side so the trampoline can
                // raise an actual `zym_runtimeError` with this text when
                // it sees is_error=1. Without this, the VM would swallow
                // the exception as a sentinel and keep executing.
                try {
                    const len = Module.lengthBytesUTF8(msg) + 1;
                    const buf = Module._malloc(len);
                    if (buf) {
                        Module.stringToUTF8(msg, buf, len);
                        Module._zjs_setDispatchError(vmPtr, buf);
                        Module._free(buf);
                    }
                } catch (_) { /* best-effort; falls back to generic text on the C side */ }
                const pushed = { status: STATUS.RUNTIME_ERROR, file: "<js>", line: -1, message: msg };
                const listeners = this.errorListeners.get(vmPtr);
                if (listeners) for (const l of listeners) { try { l(pushed); } catch (_) {} }
                let bucket = this.pendingErrors.get(vmPtr);
                if (!bucket) { bucket = []; this.pendingErrors.set(vmPtr, bucket); }
                bucket.push(pushed);
                return 0;
            }
        };
    }
}

// Read `count` uint32 handle ids from wasm memory.
function readHandleArray(Module, ptr, count) {
    if (!count || !ptr) return [];
    const out = new Array(count);
    const base = ptr >> 2;
    for (let i = 0; i < count; i++) out[i] = Module.HEAPU32[base + i];
    return out;
}

// ---------------------------------------------------------------------------
// ZymValue: lightweight wrapper around a handle id. Two flavours:
//   - "owned":   the wrapper is responsible for releasing the handle.
//                Registered with a FinalizationRegistry; explicit dispose()
//                is optional but available.
//   - "borrowed": the wrapper does NOT release the handle (used for args
//                passed to native callbacks, which are released by the
//                dispatch trampoline on the C side).
// ---------------------------------------------------------------------------
class ZymValue {
    constructor(vm, handle, owned) {
        // Internals are non-enumerable so `JSON.stringify(zymValue)` does not
        // walk into `_vm -> Module -> HEAP*` and hang/OOM. User code that
        // wants a serializable shape should call `.toJSON()` (auto-invoked
        // by JSON.stringify) or `.toJS()`.
        _hide(this, "_vm", vm);
        _hide(this, "_h", handle);
        _hide(this, "_owned", owned);
        if (owned && handle !== 0) {
            vm._finalizer.register(this, { vm, handle }, this);
        }
    }
    get handle() { return this._h; }
    get kind()   { this._assertAlive(); return this._vm._kindOf(this._h); }
    isNull()     { return this.kind === KIND.NULL; }
    isBool()     { return this.kind === KIND.BOOL; }
    isNumber()   { return this.kind === KIND.NUMBER; }
    isString()   { return this.kind === KIND.STRING; }
    isList()     { return this.kind === KIND.LIST; }
    isMap()      { return this.kind === KIND.MAP; }
    isCallable() { return this.kind === KIND.CLOSURE || this.kind === KIND.FUNCTION; }
    /**
     * Decode into the matching JS primitive/structure.
     *   - null / bool / number / string -> their JS counterparts.
     *   - list                           -> Array (recursive).
     *   - map                            -> plain Object (recursive).
     *   - struct                         -> plain Object with a non-enumerable
     *                                        `__type` tag carrying the struct's
     *                                        declared name.
     *   - enum variant                   -> frozen Object { __enum, name, ordinal }.
     *   - function / closure /           -> the ZymValue wrapper (unchanged,
     *     continuation / prompt tag /       handed back as an opaque handle
     *     unknown                           users can pass around).
     *
     * Cycles in maps/structs are preserved (the same JS object is reused the
     * second time a handle is seen), so decoding a self-referential Zym map
     * produces a self-referential JS object instead of hanging.
     */
    toJS()       { this._assertAlive(); return this._vm._decode(this._h, new Map()); }
    /**
     * Format this value using the VM's own display rules (same output the
     * `print` statement produces). Works for every kind, including enums,
     * structs, closures, continuations, etc. -- kinds for which the JS
     * wrapper otherwise has no meaningful primitive representation.
     */
    display() {
        this._assertAlive();
        return this._vm._displayString(this._h);
    }
    /**
     * String coercion: delegate to the VM's display formatter. This avoids
     * accidental recursion (toJS()-of-enum returns another ZymValue whose
     * default String() coercion would recurse forever) and avoids ever
     * calling JSON.stringify on a ZymValue (which would traverse the JS
     * back-pointer into the Emscripten Module and hang / OOM).
     */
    toString()   { return this.display(); }
    /**
     * Safe JSON form: decode to a plain JS value. Called automatically by
     * `JSON.stringify(zymValue)`.
     */
    toJSON()     { return this.toJS(); }
    /**
     * Guard: throw a clear ZymError if this wrapper is used after its VM
     * was freed, instead of reading freed wasm memory and producing
     * undefined behavior. Handle-id 0 is always legal (it is null).
     */
    _assertAlive() {
        if (this._h === 0) return;
        if (this._vm && this._vm._freed) {
            throw new ZymError("ZymValue used after its VM was freed");
        }
    }
    /** Release the handle eagerly. Safe to call multiple times. */
    dispose() {
        if (!this._owned || this._h === 0) return;
        try { this._vm._releaseHandle(this._h); } catch (_) {}
        try { this._vm._finalizer.unregister(this); } catch (_) {}
        this._h = 0;
    }
    // `Symbol.dispose` handler is attached post-definition, guarded for Node
    // versions that predate JS explicit-resource-management.
}

// ---------------------------------------------------------------------------
// VM: the primary user-facing class.
// ---------------------------------------------------------------------------
class VM {
    constructor(bridge) {
        const M = bridge.M;
        const ptr = M._zjs_newVM();
        if (!ptr) throw new ZymError("failed to create VM");

        // Non-enumerable internals (see _hide rationale on ZymValue).
        _hide(this, "_bridge", bridge);
        _hide(this, "_M", M);
        _hide(this, "_ptr", ptr);
        _hide(this, "_freed", false);
        _hide(this, "_myCallbackIds", new Set());

        // Per-VM handle finalizer: release handles whose ZymValue wrappers
        // were dropped without explicit dispose().
        _hide(this, "_finalizer", new FinalizationRegistry(({ vm, handle }) => {
            if (!vm._freed) vm._releaseHandle(handle);
        }));

        // Register this VM with the module-level finalizer so a forgotten
        // `vm.free()` does not leak the wasm VM. Captures ONLY the bits we
        // need to clean up so the registry entry does not pin the wrapper.
        const callbackIds = this._myCallbackIds;
        const vmCleanup = () => {
            // Idempotent: if free() already ran, these are harmless no-ops.
            for (const id of callbackIds) bridge.callbacks.delete(id);
            callbackIds.clear();
            bridge.errorListeners.delete(ptr);
            bridge.pendingErrors.delete(ptr);
            // Only call into wasm if the VM pointer is still live. `free()`
            // zeroes the wrapper's _ptr, but `vmCleanup` closes over the
            // original ptr -- we need a separate "freed" flag that survives
            // the wrapper going away. A WeakRef-based flag is overkill;
            // instead, stash a token object that `free()` mutates.
            if (!token.freed) {
                token.freed = true;
                M._zjs_freeVM(ptr);
            }
        };
        const token = { freed: false };
        _hide(this, "_cleanupToken", token);
        _hide(this, "_cleanup", vmCleanup);
        _vmFinalizer.register(this, vmCleanup, this);
    }

    // -------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------
    free() {
        if (this._freed) return;
        this._freed = true;
        // Invoke the same cleanup path the finalizer would run. The shared
        // _cleanupToken ensures the wasm VM is only freed once regardless
        // of which path (explicit free vs. GC finalizer) runs first.
        this._cleanup();
        // Prevent the finalizer from firing again post-GC.
        try { _vmFinalizer.unregister(this); } catch (_) {}
        this._ptr = 0;
    }
    /**
     * Safe JSON form: JSON.stringify(vm) returns a neutral summary instead
     * of walking internals and hitting wasm heap pointers.
     */
    toJSON() { return { type: "ZymVM", alive: !this._freed }; }
    // `Symbol.dispose` handler attached post-definition for Node <20.11 compat.

    // -------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------
    /** Register a callback invoked for every compile/runtime error. */
    on(event, listener) {
        if (event !== "error") throw new TypeError(`unknown event: ${event}`);
        let list = this._bridge.errorListeners.get(this._ptr);
        if (!list) { list = []; this._bridge.errorListeners.set(this._ptr, list); }
        list.push(listener);
        return () => { // return an unsubscribe fn
            const arr = this._bridge.errorListeners.get(this._ptr);
            if (!arr) return;
            const idx = arr.indexOf(listener);
            if (idx >= 0) arr.splice(idx, 1);
        };
    }

    // -------------------------------------------------------------------
    // Compile / run
    // -------------------------------------------------------------------
    compile(source, { file = "<script>", includeLineInfo = true } = {}) {
        this._checkAlive();
        const M = this._M;
        const srcPtr = _strToWasm(M, source);
        const filePtr = _strToWasm(M, file);
        const outPtr = M._malloc(4);
        try {
            this._drainErrors();
            const status = M._zjs_compile(this._ptr, srcPtr, filePtr, includeLineInfo ? 1 : 0, outPtr);
            if (status !== STATUS.OK) {
                this._throwFromStatus(status, "compile failed");
            }
            const chunkPtr = M.HEAPU32[outPtr >> 2];
            return new Chunk(this, chunkPtr);
        } finally {
            M._free(srcPtr);
            M._free(filePtr);
            M._free(outPtr);
        }
    }

    /**
     * Convenience: compile and run `source`. Returns whatever the script
     * left in the last global expression, or `undefined` if nothing.
     */
    run(source, opts) {
        const chunk = this.compile(source, opts);
        try {
            this._drainErrors();
            const status = this._M._zjs_runChunk(this._ptr, chunk._ptr);
            if (status !== STATUS.OK) this._throwFromStatus(status, "run failed");
        } finally {
            chunk.free();
        }
    }

    // -------------------------------------------------------------------
    // Bytecode
    // -------------------------------------------------------------------
    /** Serialize a previously-compiled chunk to a Uint8Array. */
    serialize(chunk, { includeLineInfo = true } = {}) {
        this._checkAlive();
        const M = this._M;
        const bufPtrPtr = M._malloc(4);
        const sizePtr = M._malloc(4);
        try {
            const status = M._zjs_serializeChunk(
                this._ptr, chunk._ptr, includeLineInfo ? 1 : 0, bufPtrPtr, sizePtr);
            if (status !== STATUS.OK) this._throwFromStatus(status, "serialize failed");
            const bufPtr = M.HEAPU32[bufPtrPtr >> 2];
            const size = M.HEAPU32[sizePtr >> 2];
            const copy = new Uint8Array(size);
            copy.set(M.HEAPU8.subarray(bufPtr, bufPtr + size));
            M._zjs_freeBytecode(bufPtr);
            return copy;
        } finally {
            M._free(bufPtrPtr);
            M._free(sizePtr);
        }
    }

    /** Load bytecode produced by `serialize` into a new chunk. */
    loadBytecode(bytes) {
        this._checkAlive();
        const M = this._M;
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const bufPtr = M._malloc(arr.length);
        M.HEAPU8.set(arr, bufPtr);
        // Allocate a fresh chunk to deserialize into. Use compile's helper path:
        // we need a chunk pointer but have no dedicated "new chunk" export, so
        // we fake it via a dummy compile of `""` and then deserialize on top.
        // Simpler: expose `zjs_newChunk` later; for now, parse an empty script
        // to get an allocated chunk and then overwrite its contents.
        const empty = this.compile("", { includeLineInfo: false });
        try {
            const status = M._zjs_deserializeChunk(this._ptr, empty._ptr, bufPtr, arr.length);
            if (status !== STATUS.OK) this._throwFromStatus(status, "deserialize failed");
            return empty;
        } finally {
            M._free(bufPtr);
        }
    }

    // -------------------------------------------------------------------
    // Natives, globals, script functions
    // -------------------------------------------------------------------
    /**
     * Register `fn` as a Zym native named/typed according to `signature`.
     * Example signatures:
     *    "now()"
     *    "greet(name)"
     *    "log(level, ...)"   (variadic: `...` marks the rest)
     *
     * The JS function receives wrapped `ZymValue` args. Return a JS value;
     * it will be marshalled automatically. Throw to surface a runtime error.
     */
    registerNative(signature, fn) {
        this._checkAlive();
        if (typeof fn !== "function") throw new TypeError("fn must be a function");
        const cbId = this._bridge.nextCbId++;
        this._bridge.callbacks.set(cbId, { fn, vm: this });
        this._myCallbackIds.add(cbId);
        const M = this._M;
        const sigPtr = _strToWasm(M, signature);
        try {
            const isVariadic = /\.\.\./.test(signature);
            const status = isVariadic
                ? M._zjs_registerNativeVariadic(this._ptr, sigPtr, cbId)
                : M._zjs_registerNative(this._ptr, sigPtr, cbId);
            if (status !== STATUS.OK) {
                this._bridge.callbacks.delete(cbId);
                this._myCallbackIds.delete(cbId);
                this._throwFromStatus(status, `registerNative(${signature}) failed`);
            }
        } finally {
            M._free(sigPtr);
        }
    }

    /** Define a global variable visible from Zym code. */
    defineGlobal(name, value) {
        this._checkAlive();
        const handle = this._marshalToHandle(value, "transfer");
        const M = this._M;
        const namePtr = _strToWasm(M, name);
        try {
            const status = M._zjs_defineGlobal(this._ptr, namePtr, handle);
            if (status !== STATUS.OK) this._throwFromStatus(status, `defineGlobal(${name}) failed`);
        } finally {
            // The handle was recorded in Zym's globals table which roots it,
            // so our wrapper handle is safe to drop here.
            this._releaseHandle(handle);
            M._free(namePtr);
        }
    }

    /**
     * Call a Zym script function and return its result.
     */
    call(funcName, ...args) {
        this._checkAlive();
        const M = this._M;
        const namePtr = _strToWasm(M, funcName);
        try {
            return this._invoke(args, (argvPtr, resultPtr) =>
                M._zjs_callFunction(this._ptr, namePtr, args.length, argvPtr, resultPtr),
                `call(${funcName}) failed`);
        } finally {
            M._free(namePtr);
        }
    }

    /**
     * Call an arbitrary callable value (function or closure) held by handle.
     * Mirrors `call()` but takes a raw handle or a `ZymValue` wrapper instead
     * of a global name. Primarily used internally to back the JS-callable
     * wrappers that `toJS()` now returns for Zym functions/closures.
     */
    callValue(callable, args = []) {
        this._checkAlive();
        const handle = (callable instanceof ZymValue)
            ? (callable._assertAlive(), callable._h)
            : (callable | 0);
        if (!handle) throw new ZymError("callValue: missing callable handle");
        const M = this._M;
        return this._invoke(args, (argvPtr, resultPtr) =>
            M._zjs_callValue(this._ptr, handle, args.length, argvPtr, resultPtr),
            `callValue failed`);
    }

    /**
     * Shared call machinery for `call` / `callValue`. Marshals args, invokes
     * `op(argvPtr, resultPtr)`, decodes the result, and always releases the
     * temporary arg handles plus any native bookkeeping.
     */
    _invoke(args, op, errLabel) {
        const M = this._M;
        const argvPtr = args.length > 0 ? M._malloc(4 * args.length) : 0;
        const resultPtr = M._malloc(4);
        const ownedHandles = [];
        try {
            const argsArr = new Uint32Array(args.length || 1);
            for (let i = 0; i < args.length; i++) {
                const h = this._marshalToHandle(args[i], "transfer");
                ownedHandles.push(h);
                argsArr[i] = h;
            }
            if (args.length > 0) {
                M.HEAPU32.set(argsArr.subarray(0, args.length), argvPtr >> 2);
            }
            this._drainErrors();
            const status = op(argvPtr, resultPtr);
            if (status !== STATUS.OK) this._throwFromStatus(status, errLabel);
            const rh = M.HEAPU32[resultPtr >> 2];
            const result = this._decode(rh);
            if (rh) this._releaseHandle(rh);
            return result;
        } finally {
            for (const h of ownedHandles) this._releaseHandle(h);
            if (argvPtr) M._free(argvPtr);
            M._free(resultPtr);
        }
    }

    // -------------------------------------------------------------------
    // Internal helpers (underscore-prefixed; not part of the public API)
    // -------------------------------------------------------------------
    _checkAlive() {
        if (this._freed) throw new ZymError("VM has been freed");
    }

    _kindOf(handle) {
        return this._M._zjs_valueKind(this._ptr, handle);
    }

    _releaseHandle(handle) {
        if (this._freed || !handle) return;
        this._M._zjs_releaseHandle(this._ptr, handle);
    }

    /**
     * Format a handle's value using the VM's display rules (mirrors
     * `zym_printValue`). Allocates a temporary Zym string via the shim,
     * reads it out, and releases it immediately. Returns an empty string
     * if the handle is 0 (null) or if formatting fails.
     */
    _displayString(handle) {
        if (this._freed || !handle) return handle === 0 ? "null" : "";
        const M = this._M;
        const strH = M._zjs_valueToString(this._ptr, handle);
        if (!strH) return "";
        const lenPtr = M._malloc(4);
        try {
            const ptr = M._zjs_asString(this._ptr, strH, lenPtr);
            const len = M.HEAP32[lenPtr >> 2];
            if (!ptr || !len) return "";
            return M.UTF8ToString(ptr, len);
        } finally {
            M._free(lenPtr);
            this._releaseHandle(strH);
        }
    }

    _wrapBorrowed(handle) { return new ZymValue(this, handle, /*owned*/ false); }

    /**
     * Convert a JS value into a handle owned by the caller. `ownership` is:
     *   "transfer" - caller takes ownership and must release.
     *   "borrow"   - caller promises to release before returning to Zym.
     * (In practice both do the same thing right now; the parameter exists
     * so future optimizations can distinguish the two code paths.)
     */
    _marshalToHandle(v, _ownership = "transfer") {
        const M = this._M;
        if (v === null || v === undefined) return 0;
        if (v instanceof ZymValue) return v._h;  // pass-through, shared ownership
        const t = typeof v;
        if (t === "boolean") return M._zjs_newBool(this._ptr, v ? 1 : 0);
        if (t === "number")  return M._zjs_newNumber(this._ptr, v);
        if (t === "bigint")  return M._zjs_newNumber(this._ptr, Number(v));
        if (t === "string") {
            const bytes = M.lengthBytesUTF8(v);
            const ptr = M._malloc(bytes + 1);
            M.stringToUTF8(v, ptr, bytes + 1);
            const h = M._zjs_newString(this._ptr, ptr, bytes);
            M._free(ptr);
            return h;
        }
        if (Array.isArray(v)) {
            const h = M._zjs_newList(this._ptr);
            for (const item of v) {
                const ih = this._marshalToHandle(item, "transfer");
                M._zjs_listAppend(this._ptr, h, ih);
                if (ih) this._releaseHandle(ih);
            }
            return h;
        }
        if (t === "object") {
            const h = M._zjs_newMap(this._ptr);
            for (const [k, val] of Object.entries(v)) {
                const vh = this._marshalToHandle(val, "transfer");
                const keyPtr = _strToWasm(M, k);
                M._zjs_mapSet(this._ptr, h, keyPtr, vh);
                M._free(keyPtr);
                if (vh) this._releaseHandle(vh);
            }
            return h;
        }
        throw new TypeError(`cannot marshal ${t} to a Zym value`);
    }

    /**
     * Convert a handle to a plain JS value. `seen` is a Map<handle, jsValue>
     * used to preserve shared references and break cycles during a single
     * top-level `toJS()` call. Pre-seed container entries before recursing
     * so that a self-referential Zym map decodes to a self-referential JS
     * object instead of recursing forever.
     */
    _decode(handle, seen = new Map()) {
        if (!handle) return null;
        const M = this._M;
        const kind = this._kindOf(handle);
        // Only containers need cycle tracking; primitives don't.
        if (seen && (kind === KIND.LIST || kind === KIND.MAP || kind === KIND.STRUCT)) {
            const prior = seen.get(handle);
            if (prior !== undefined) return prior;
        }
        switch (kind) {
            case KIND.NULL:   return null;
            case KIND.BOOL:   return M._zjs_asBool(this._ptr, handle) !== 0;
            case KIND.NUMBER: return M._zjs_asNumber(this._ptr, handle);
            case KIND.STRING: return this._readZymString(handle);
            case KIND.LIST: {
                const n = M._zjs_listLength(this._ptr, handle);
                const out = new Array(n);
                if (seen) seen.set(handle, out);
                for (let i = 0; i < n; i++) {
                    const ih = M._zjs_listGet(this._ptr, handle, i);
                    out[i] = this._decode(ih, seen);
                    if (ih) this._releaseHandle(ih);
                }
                return out;
            }
            case KIND.MAP: {
                const obj = {};
                if (seen) seen.set(handle, obj);
                const keysH = M._zjs_mapKeys(this._ptr, handle);
                if (keysH) {
                    try {
                        const kcount = M._zjs_listLength(this._ptr, keysH);
                        for (let i = 0; i < kcount; i++) {
                            const keyStrH = M._zjs_listGet(this._ptr, keysH, i);
                            let key;
                            try { key = this._readZymString(keyStrH); }
                            finally { if (keyStrH) this._releaseHandle(keyStrH); }
                            const keyPtr = _strToWasm(M, key);
                            const valH = M._zjs_mapGet(this._ptr, handle, keyPtr);
                            M._free(keyPtr);
                            obj[key] = this._decode(valH, seen);
                            if (valH) this._releaseHandle(valH);
                        }
                    } finally {
                        this._releaseHandle(keysH);
                    }
                }
                return obj;
            }
            case KIND.STRUCT: {
                const obj = {};
                // Tag with the declared struct type name (non-enumerable so
                // it round-trips cleanly through JSON.stringify).
                const namePtr = M._zjs_structName(this._ptr, handle);
                if (namePtr) {
                    Object.defineProperty(obj, "__type", {
                        value: M.UTF8ToString(namePtr),
                        enumerable: false, writable: false, configurable: false,
                    });
                }
                if (seen) seen.set(handle, obj);
                const n = M._zjs_structFieldCount(this._ptr, handle);
                for (let i = 0; i < n; i++) {
                    const fnPtr = M._zjs_structFieldNameAt(this._ptr, handle, i);
                    if (!fnPtr) continue;
                    const fname = M.UTF8ToString(fnPtr);
                    const fnameBuf = _strToWasm(M, fname);
                    const valH = M._zjs_structGetField(this._ptr, handle, fnameBuf);
                    M._free(fnameBuf);
                    obj[fname] = this._decode(valH, seen);
                    if (valH) this._releaseHandle(valH);
                }
                return obj;
            }
            case KIND.ENUM: {
                const typePtr = M._zjs_enumTypeName(this._ptr, handle);
                const varPtr  = M._zjs_enumVariantName(this._ptr, handle);
                return Object.freeze({
                    __enum:  typePtr ? M.UTF8ToString(typePtr) : "",
                    name:    varPtr  ? M.UTF8ToString(varPtr)  : "",
                    ordinal: M._zjs_enumVariantIndex(this._ptr, handle),
                });
            }
            case KIND.FUNCTION:
            case KIND.CLOSURE:
                return this._makeCallable(handle);
            // Continuations, prompt tags, and anything unrecognized are
            // handed back as an opaque wrapper for advanced use.
            default:
                return new ZymValue(this, handle, /*owned*/ false);
        }
    }

    /**
     * Wrap a Zym FUNCTION/CLOSURE handle as a real JS callable. The returned
     * function owns its own duplicate of the handle (so it outlives whatever
     * ephemeral handle `_decode` was handed); a FinalizationRegistry releases
     * that duplicate when the JS function itself is collected. Users who want
     * deterministic cleanup can call `.free()` or `using fn = ...`.
     */
    _makeCallable(srcHandle) {
        const vm = this;
        const M = this._M;
        // Allocate our own handle so the returned callable's lifetime is
        // independent of whichever transient handle _decode was given.
        const dupH = M._zjs_dupHandle(this._ptr, srcHandle);
        if (!dupH) {
            // Fall back to the opaque wrapper if dup failed for any reason.
            return new ZymValue(this, srcHandle, false);
        }

        // Weak VM reference avoids pinning the VM wrapper via the callable.
        const vmRef = new WeakRef(vm);
        const state = { released: false };

        const callable = function (...args) {
            if (state.released) throw new ZymError("callable has been freed");
            const liveVm = vmRef.deref();
            if (!liveVm || liveVm._freed) throw new ZymError("VM has been freed");
            return liveVm.callValue(dupH, args);
        };

        // Deterministic release path.
        const release = () => {
            if (state.released) return;
            state.released = true;
            _callableFinalizer.unregister(state);
            const liveVm = vmRef.deref();
            if (liveVm && !liveVm._freed) {
                try { liveVm._M._zjs_releaseHandle(liveVm._ptr, dupH); }
                catch (_) { /* swallow */ }
            }
        };

        _hide(callable, "free", release);
        _hide(callable, "dispose", release);
        if (typeof Symbol !== "undefined" && Symbol.dispose) {
            _hide(callable, Symbol.dispose, release);
        }
        _hide(callable, "__zymCallable", true);

        // Finalizer: if the callable is GC'd without `.free()`, release the
        // dup handle so the Zym GC can reclaim the underlying function.
        _callableFinalizer.register(callable, () => {
            if (state.released) return;
            state.released = true;
            const liveVm = vmRef.deref();
            if (liveVm && !liveVm._freed) {
                try { liveVm._M._zjs_releaseHandle(liveVm._ptr, dupH); }
                catch (_) { /* swallow */ }
            }
        }, state);

        return callable;
    }

    /**
     * Read a Zym string (known to be kind STRING) into a JS string.
     */
    _readZymString(handle) {
        if (!handle) return "";
        const M = this._M;
        const lenPtr = M._malloc(4);
        try {
            const strPtr = M._zjs_asString(this._ptr, handle, lenPtr);
            const len = M.HEAP32[lenPtr >> 2];
            if (!strPtr || !len) return "";
            return M.UTF8ToString(strPtr, len);
        } finally { M._free(lenPtr); }
    }

    _drainErrors() {
        this._bridge.pendingErrors.set(this._ptr, []);
    }

    _throwFromStatus(status, label) {
        const details = this._bridge.pendingErrors.get(this._ptr) || [];
        const msg = details.length > 0
            ? `${label}: ${details.map((e) => e.message).join("\n")}`
            : `${label} (status=${status})`;
        throw new ZymError(msg, { status, details });
    }
}

// ---------------------------------------------------------------------------
// Chunk: opaque compiled program. Only useful for saving/loading bytecode or
// running the same program multiple times; single-shot users should prefer
// `vm.run(source)` which manages the chunk internally.
// ---------------------------------------------------------------------------
class Chunk {
    constructor(vm, ptr) {
        _hide(this, "_vm", vm);
        _hide(this, "_ptr", ptr);
        _hide(this, "_owned", true);

        // Register with the chunk finalizer so forgotten chunks are freed.
        // Capture only primitives / the underlying wasm module to avoid
        // pinning either the VM wrapper or this Chunk wrapper.
        const M = vm._M;
        const vmPtr = vm._ptr;
        const vmToken = vm._cleanupToken;
        const chunkToken = { freed: false };
        _hide(this, "_chunkToken", chunkToken);
        const cleanup = () => {
            if (chunkToken.freed) return;
            chunkToken.freed = true;
            if (vmToken && vmToken.freed) return;   // VM gone, chunk memory already gone
            try { M._zjs_freeChunk(vmPtr, ptr); } catch (_) {}
        };
        _hide(this, "_cleanup", cleanup);
        _chunkFinalizer.register(this, cleanup, this);
    }
    run() {
        this._vm._checkAlive();
        this._vm._drainErrors();
        const status = this._vm._M._zjs_runChunk(this._vm._ptr, this._ptr);
        if (status !== STATUS.OK) this._vm._throwFromStatus(status, "run failed");
    }
    free() {
        if (!this._owned || !this._ptr || this._vm._freed) return;
        this._owned = false;
        this._cleanup();
        try { _chunkFinalizer.unregister(this); } catch (_) {}
        this._ptr = 0;
    }
    toJSON() { return { type: "ZymChunk", alive: this._owned && !!this._ptr }; }
}

// Attach `using` / `Symbol.dispose` handlers only if the runtime actually
// has the symbol. On older Node (<20.11) this is a no-op; on modern
// runtimes the `using vm = await Zym.newVM()` syntax Just Works.
if (typeof Symbol !== "undefined" && typeof Symbol.dispose === "symbol") {
    VM.prototype[Symbol.dispose]       = function () { this.free(); };
    Chunk.prototype[Symbol.dispose]    = function () { this.free(); };
    ZymValue.prototype[Symbol.dispose] = function () { this.dispose(); };
}

// ---------------------------------------------------------------------------
// String marshalling helper.
// ---------------------------------------------------------------------------
function _strToWasm(M, s) {
    if (s === null || s === undefined) return 0;
    const bytes = M.lengthBytesUTF8(s);
    const ptr = M._malloc(bytes + 1);
    M.stringToUTF8(s, ptr, bytes + 1);
    return ptr;
}

// ---------------------------------------------------------------------------
// Re-exports so advanced users can access the tag dictionaries.
// ---------------------------------------------------------------------------
export { ZymValue, KIND, STATUS, Zym };
