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
    OK: 0, COMPILE_ERROR: 1, RUNTIME_ERROR: 2, SUSPENDED: 3, BRIDGE_ERROR: 100,
});

// What a VM *is*, as opposed to what one call returned.
const STATE = Object.freeze({
    IDLE: 0, RUNNING: 1, SUSPENDED: 2, FAILED: 3,
});

// Why it is there. Every pause reports STATUS.SUSPENDED because it is one VM
// state; the cause is what tells you whether to grant more time, more memory,
// or give up. New reasons to stop are added here rather than to STATE or
// STATUS, so existing branches keep meaning what they meant.
const CAUSE = Object.freeze({
    NONE: 0,
    SCRIPT_YIELD: 1,       // reserved: the language has no cooperative yield yet
    PREEMPT: 2,            // a watchdog or preemption entry expired
    PREEMPT_BLOCKED: 3,    // a preempt callback could not be run
    HOST_STOP: 4,          // requestStop()
    MEMORY_LIMIT: 5,       // the memory ceiling was crossed
    OUT_OF_MEMORY: 6,      // the allocator itself failed; not resumable
    RUNTIME_ERROR: 7,
    COMPILE_ERROR: 8,
});

// Preemption entry flags (zym_core/include/zym/zym.h).
const PREEMPT_MASKABLE = 1 << 0;   // a script shield may suppress it
const PREEMPT_ONESHOT  = 1 << 1;   // retire after firing instead of rearming

// ZymDiagSeverity mirror (zym_core/include/zym/diagnostics.h).
const SEVERITY = ["error", "warning", "info", "hint"];

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

/**
 * Thrown when a VM pauses rather than fails: a watchdog fired, a stop was
 * requested, or the memory ceiling was crossed. The VM is intact and usually
 * resumable -- check `resumable` -- so this is a decision point, not a
 * breakage. Kept distinct from ZymError so "I stopped it" and "it failed on its
 * own" never get confused.
 */
export class ZymSuspended extends ZymError {
    constructor(message, info) {
        super(message, { status: STATUS.SUSPENDED });
        this.name = "ZymSuspended";
        this.cause = info.cause;
        this.state = info.state;
        this.resumable = info.resumable;
        this.preemptId = info.preemptId;
        this.bytesWanted = info.bytesWanted;
        this.memoryUsed = info.memoryUsed;
        this.memoryLimit = info.memoryLimit;
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
    /** vmPtr -> { read, resolve } for the in-flight compileWithModules call. */
    static _moduleHooks = new Map();

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

        // Module source hooks. Populated per-call by compileWithModules();
        // the bridge calls these synchronously while resolving imports.
        Module.__zjs_moduleRead = (vmPtr, path) => {
            const h = Bridge._moduleHooks.get(vmPtr);
            if (!h || typeof h.read !== "function") return null;
            const src = h.read(path);
            return typeof src === "string" ? src : null;
        };
        Module.__zjs_moduleResolve = (vmPtr, spec, importer) => {
            const h = Bridge._moduleHooks.get(vmPtr);
            if (!h || typeof h.resolve !== "function") return null;
            const r = h.resolve(spec, importer);
            return typeof r === "string" ? r : null;
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
        if (this._dispatching) {
            throw new ZymError("run(): cannot start a run from inside a preempt handler");
        }
        const chunk = this.compile(source, opts);
        this._releasePending();
        let suspended = false;
        try {
            this._drainErrors();
            let status = this._M._zjs_runChunk(this._ptr, chunk._ptr);
            status = this._pumpPreempts(status);
            if (status === STATUS.SUSPENDED) {
                // The VM is parked with its instruction pointer inside this
                // chunk. Freeing it here would make resume() impossible, so
                // hold it until the run finishes or another one supersedes it.
                suspended = true;
                this._pendingChunk = chunk;
                this._throwSuspended("run suspended");
            }
            if (status !== STATUS.OK) this._throwFromStatus(status, "run failed");
        } finally {
            if (!suspended) chunk.free();
        }
    }

    /**
     * Continue a suspended VM. Returns normally once the script completes,
     * throws ZymSuspended if it pauses again, and throws ZymError if it fails.
     *
     * Whatever suspended it must be cleared first: a watchdog needs no action
     * (each resume grants a fresh slice), but a stop needs clearStop() and a
     * memory ceiling needs room. `info().resumable` folds that together.
     */
    resume() {
        this._checkAlive();
        if (this._dispatching) {
            throw new ZymError("resume(): already inside a preempt handler");
        }
        this._drainErrors();
        let status = this._M._zjs_resume(this._ptr);
        status = this._pumpPreempts(status);
        if (status === STATUS.SUSPENDED) this._throwSuspended("resume suspended");
        this._releasePending();
        if (status !== STATUS.OK) this._throwFromStatus(status, "resume failed");
    }

    /** Drop a chunk held for a suspension that is no longer being resumed. */
    _releasePending() {
        if (this._pendingChunk) {
            const c = this._pendingChunk;
            this._pendingChunk = null;
            c.free();
        }
    }

    _throwSuspended(what) {
        const i = this.info();
        const why = {
            [CAUSE.PREEMPT]:         "execution budget exhausted",
            [CAUSE.PREEMPT_BLOCKED]: "a preemption callback could not be run",
            [CAUSE.HOST_STOP]:       "stop requested",
            [CAUSE.MEMORY_LIMIT]:    "memory ceiling reached",
        }[i.cause] || "suspended";
        throw new ZymSuspended(`${what}: ${why}`, i);
    }

    // ---- sandbox controls -------------------------------------------------

    /**
     * Add a preemption entry: every `slice` instructions the VM hands control
     * back, rearming each time. Non-maskable, so script cannot defer it.
     * Returns an id.
     *
     * With a handler, the handler runs and execution continues automatically,
     * which makes an entry an event pump into the script: progress reporting,
     * deadline checks, delivering a tick to a script-side hook. The handler may
     * call into the VM (`vm.call(...)`) and the parked run survives it.
     * Returning `false` stops instead of resuming.
     *
     * Without a handler there is nothing to run, so the VM stays suspended and
     * `run()` throws ZymSuspended. That is the watchdog shape, and it is the
     * same entry with the handler left out.
     *
     * Throws if the preemption table is full.
     */
    addPreempt(slice, handler, { once = false, maskable = false } = {}) {
        this._checkAlive();
        const flags = (maskable ? PREEMPT_MASKABLE : 0) | (once ? PREEMPT_ONESHOT : 0);
        const id = this._M._zjs_addPreempt(this._ptr, slice | 0, flags);
        if (id === 0) throw new ZymError("addPreempt: no free preemption slots");
        if (typeof handler === "function") {
            if (!this._preempts) _hide(this, "_preempts", new Map());
            this._preempts.set(id >>> 0, { fn: handler, once: !!once });
        }
        return id >>> 0;
    }

    /** Remove an entry and forget its handler. False if the id is unknown. */
    removePreempt(id) {
        this._checkAlive();
        const key = id >>> 0;
        if (this._preempts) this._preempts.delete(key);
        return this._M._zjs_removePreempt(this._ptr, key) !== 0;
    }

    /** Restart an entry's countdown, so a handler can retune its own cadence. */
    setPreemptSlice(id, slice) {
        this._checkAlive();
        return this._M._zjs_setPreemptSlice(this._ptr, id >>> 0, slice | 0) !== 0;
    }

    /**
     * Dispatch handlers for entries that have one, resuming after each, until
     * the VM finishes or suspends for something the caller has to decide about.
     */
    _pumpPreempts(status) {
        while (status === STATUS.SUSPENDED) {
            if (this._M._zjs_vmCause(this._ptr) !== CAUSE.PREEMPT) return status;

            const id = this._M._zjs_causePreemptId(this._ptr) >>> 0;
            const rec = this._preempts && this._preempts.get(id);
            if (!rec) return status;         // no handler: hand it to the caller
            const fn = rec.fn;

            // A one-shot entry is retired by the VM as it fires, so drop our
            // handler with it rather than holding the closure for an id that
            // no longer exists -- and that a later register could reuse.
            if (rec.once) this._preempts.delete(id);

            // Guard re-entry: a handler may call into the VM, but starting a
            // second run or resume from inside one is not something the single
            // parked chunk can represent.
            _hide(this, "_dispatching", true);
            let keepGoing;
            try { keepGoing = fn(this.info(), id); }
            finally { _hide(this, "_dispatching", false); }

            if (keepGoing === false) return status;   // handler asked to stop
            if (this._freed) return status;           // handler freed the VM
            status = this._M._zjs_resume(this._ptr);
        }
        return status;
    }

    /** Stop at the next instruction. Unmaskable and sticky until clearStop(). */
    requestStop()   { this._checkAlive(); this._M._zjs_requestStop(this._ptr); }
    clearStop()     { this._checkAlive(); this._M._zjs_clearStop(this._ptr); }
    stopRequested() { this._checkAlive(); return this._M._zjs_stopRequested(this._ptr) !== 0; }

    /**
     * Cap how much this VM may allocate. 0 means unlimited, the default.
     * Crossing it suspends rather than failing the allocation, so you choose
     * whether to grant more, free memory, or discard the VM. Raising the limit
     * above current usage clears the condition on its own.
     */
    setMemoryLimit(bytes) {
        this._checkAlive();
        this._M._zjs_setMemoryLimit(this._ptr, Number(bytes) || 0);
    }
    memoryLimit() { this._checkAlive(); return this._M._zjs_memoryLimit(this._ptr); }
    memoryUsed()  { this._checkAlive(); return this._M._zjs_memoryUsed(this._ptr); }
    oomPending()  { this._checkAlive(); return this._M._zjs_oomPending(this._ptr) !== 0; }
    clearOom()    { this._checkAlive(); this._M._zjs_clearOom(this._ptr); }

    /**
     * One snapshot of the VM: what it is, why, and whether resume() would get
     * anywhere. Taken together so the fields cannot disagree with each other.
     */
    info() {
        this._checkAlive();
        const M = this._M;
        return {
            state:       M._zjs_vmState(this._ptr),
            cause:       M._zjs_vmCause(this._ptr),
            resumable:   M._zjs_vmResumable(this._ptr) !== 0,
            preemptId:   M._zjs_causePreemptId(this._ptr) >>> 0,
            bytesWanted: M._zjs_causeBytesWanted(this._ptr),
            memoryUsed:  M._zjs_memoryUsed(this._ptr),
            memoryLimit: M._zjs_memoryLimit(this._ptr),
        };
    }

    /**
     * Hold `slots` preemption entries back from script so you can still arm a
     * watchdog after it has been running. Must be called before the VM executes
     * anything: that is what lets a script treat its budget as fixed.
     */
    setPreemptReserve(slots) {
        this._checkAlive();
        if (this._M._zjs_setPreemptReserve(this._ptr, slots | 0) === 0) {
            throw new ZymError(
                "setPreemptReserve: out of range, or the VM has already executed");
        }
    }
    preemptReserve()  { this._checkAlive(); return this._M._zjs_preemptReserve(this._ptr); }
    preemptCapacity() { this._checkAlive(); return this._M._zjs_preemptCapacity(); }
    preemptUsed()     { this._checkAlive(); return this._M._zjs_preemptUsed(this._ptr); }

    /**
     * Instructions left before entry `id` fires. -1 if the id is unknown, so
     * this doubles as a liveness check. Allocates nothing, which is what makes
     * it usable from inside a handler retuning its own cadence.
     */
    preemptRemaining(id) {
        this._checkAlive();
        return this._M._zjs_preemptRemaining(this._ptr, id >>> 0);
    }

    /**
     * Arm entry `id` to fire at the next instruction rather than when its
     * countdown runs out. False if the id is unknown.
     *
     * Nothing else in JS runs while a script does, so this is not a way to
     * interrupt from outside -- use it from inside another entry's handler, or
     * between run() and resume(), to make one fire early.
     */
    triggerPreempt(id) {
        this._checkAlive();
        return this._M._zjs_preemptTrigger(this._ptr, id >>> 0) !== 0;
    }

    /**
     * One snapshot of the entry table, taken together so the numbers cannot
     * disagree with each other -- the same shape as info() for VM state.
     *
     * `capacity` is the whole table, fixed at build time. `reserve` is what is
     * held back from script, so `scriptCapacity` is what is left for it and
     * `available` is what anyone could still take right now.
     *
     * `entries` lists the live ones with their countdowns; `handler` says
     * whether this VM has a JS function bound to that id, which is the
     * difference between an entry that resumes itself and one that suspends.
     */
    preempts() {
        this._checkAlive();
        const M = this._M, p = this._ptr;
        const capacity = M._zjs_preemptCapacity();
        const used     = M._zjs_preemptUsed(p);

        const entries = [];
        if (used > 0) {
            const buf = M._malloc(used * 4);
            try {
                const n = Math.min(M._zjs_preemptIds(p, buf, used), used);
                for (let i = 0; i < n; i++) {
                    const id = M.HEAPU32[(buf >> 2) + i] >>> 0;
                    entries.push({
                        id,
                        remaining: M._zjs_preemptRemaining(p, id),
                        handler:   !!(this._preempts && this._preempts.has(id)),
                    });
                }
            } finally { M._free(buf); }
        }

        const scriptUsed = M._zjs_preemptScriptUsed(p);
        return {
            capacity,
            used,
            free: capacity - used,
            reserve:         M._zjs_preemptReserve(p),
            scriptUsed,
            hostUsed:        used - scriptUsed,
            scriptCapacity:  M._zjs_preemptScriptCapacity(p),
            scriptAvailable: M._zjs_preemptScriptAvailable(p),
            entries,
        };
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

    /**
     * Structured diagnostics recorded by the frontend since the last clear.
     * Mirrors `vm.diagnostics()` on the CLI's `Zym` native. Each record is
     * `{ severity, fileId, startByte, length, line, column, message,
     *    code?, hint? }`. Severity is one of "error" | "warning" | "info"
     * | "hint". Reading does not clear; call `clearDiagnostics()` for that.
     */
    /**
     * Compile an entry module plus everything it imports.
     *
     * `read(path)` returns the source text for a resolved module path, or
     * null if it does not exist. `resolve(spec, importer)` is optional and
     * maps a raw import specifier to a canonical key; return null to fall
     * back to the loader's default path join. `importer` is null while
     * resolving the entry module.
     *
     * Both hooks are synchronous, so do any fetching before calling.
     *
     * @example
     *   const files = new Map([["./util.zym", "func double(n){ return n*2 }"]]);
     *   const chunk = vm.compileWithModules(entry, { read: (p) => files.get(p) ?? null });
     */
    compileWithModules(source, {
        file = "<script>", read, resolve,
        debugNames = true, includeLineInfo = true,
    } = {}) {
        this._checkAlive();
        if (typeof read !== "function") {
            throw new TypeError("compileWithModules requires a read(path) function");
        }
        const M = this._M;
        const srcPtr = _strToWasm(M, source);
        const filePtr = _strToWasm(M, file);
        const outPtr = M._malloc(4);
        Bridge._moduleHooks.set(this._ptr, { read, resolve });
        try {
            this._drainErrors();
            const status = M._zjs_compileWithModules(
                this._ptr, srcPtr, filePtr,
                debugNames ? 1 : 0, includeLineInfo ? 1 : 0,
                typeof resolve === "function" ? 1 : 0, outPtr);
            if (status !== STATUS.OK) {
                this._throwFromStatus(status, "compileWithModules failed");
            }
            return new Chunk(this, M.HEAPU32[outPtr >> 2]);
        } finally {
            Bridge._moduleHooks.delete(this._ptr);
            M._free(srcPtr);
            M._free(filePtr);
            M._free(outPtr);
        }
    }

    /**
     * The import chain being resolved, outermost first. Only meaningful
     * inside a `read` or `resolve` hook; returns [] otherwise.
     */
    importStack() {
        this._checkAlive();
        const M = this._M;
        const depth = M._zjs_currentImportDepth(this._ptr);
        const out = [];
        for (let i = 0; i < depth; i++) {
            const p = M._zjs_currentImportPathAt(this._ptr, i);
            out.push(p ? M.UTF8ToString(p) : "");
        }
        return out;
    }

    /** The module that issued the import being resolved, or null. */
    importCaller() {
        this._checkAlive();
        const p = this._M._zjs_currentImportCaller(this._ptr);
        return p ? this._M.UTF8ToString(p) : null;
    }

    diagnostics() {
        this._checkAlive();
        const M = this._M;
        const count = M._zjs_diagnosticCount(this._ptr);
        const out = [];
        for (let i = 0; i < count; i++) {
            const f = (field) => M._zjs_diagnosticField(this._ptr, i, field);
            const s = (ptr) => (ptr ? M.UTF8ToString(ptr) : null);
            const rec = {
                severity: SEVERITY[f(0)] ?? "error",
                fileId: f(1),
                startByte: f(2),
                length: f(3),
                line: f(4),
                column: f(5),
                message: s(M._zjs_diagnosticMessage(this._ptr, i)) ?? "",
            };
            const code = s(M._zjs_diagnosticCode(this._ptr, i));
            const hint = s(M._zjs_diagnosticHint(this._ptr, i));
            if (code) rec.code = code;
            if (hint) rec.hint = hint;
            out.push(rec);
        }
        return out;
    }

    /** Drop every recorded diagnostic. */
    clearDiagnostics() {
        this._checkAlive();
        this._M._zjs_clearDiagnostics(this._ptr);
    }

    /**
     * Ask the VM to stop at the next safe point. Safe to call while a
     * compile or run is in flight, which is how a host stops a runaway
     * script without tearing down the VM.
     */
    requestCancel() {
        this._checkAlive();
        this._M._zjs_requestCancel(this._ptr);
    }

    /** True if the last operation stopped because of `requestCancel()`. */
    wasCancelled() {
        this._checkAlive();
        return this._M._zjs_wasCancelled(this._ptr) !== 0;
    }

    /** Clear the cancellation flag before reusing the VM. */
    clearCancel() {
        this._checkAlive();
        this._M._zjs_clearCancel(this._ptr);
    }

    /** True if a function with this name and arity is callable. */
    hasFunction(name, arity) {
        this._checkAlive();
        const M = this._M;
        const namePtr = _strToWasm(M, name);
        try {
            return M._zjs_hasFunction(this._ptr, namePtr, arity | 0) !== 0;
        } finally {
            M._free(namePtr);
        }
    }

    /**
     * Existence probe. With one argument, true if *any* callable by that name
     * exists at any arity, fixed or variadic. With two, true if a call with
     * exactly `arity` arguments would dispatch, which includes a variadic whose
     * fixed prefix is short enough.
     *
     * Use this for entry-point discovery -- `if (vm.hasFunc("main"))` -- where
     * hasFunction's exact-slot match would miss a variadic `main(...args)`.
     */
    hasFunc(name, arity) {
        this._checkAlive();
        const M = this._M;
        const namePtr = _strToWasm(M, name);
        try {
            return arity === undefined
                ? M._zjs_hasAnyFunction(this._ptr, namePtr) !== 0
                : M._zjs_canCallWith(this._ptr, namePtr, arity | 0) !== 0;
        } finally {
            M._free(namePtr);
        }
    }

    /**
     * A reusable callable bound to a script function, or null if no function by
     * that name exists. Calling it is equivalent to `vm.call(name, ...args)`,
     * but the name is resolved once and the result can be passed around like an
     * ordinary JS function.
     *
     * Identity-stable: the same name returns the same function object every
     * time, so it can be used as a Map key or compared by reference.
     */
    getFunc(name) {
        this._checkAlive();
        if (!this.hasFunc(name)) return null;

        if (!this._funcCache) _hide(this, "_funcCache", new Map());
        const hit = this._funcCache.get(name);
        if (hit) return hit;

        const vm = this;
        const fn = (...args) => vm.call(name, ...args);
        Object.defineProperty(fn, "name", { value: name, configurable: true });
        this._funcCache.set(name, fn);
        return fn;
    }

    /**
     * Human-readable disassembly of a chunk. Mirrors the CLI's
     * `vm.disassembleChunk(chunk, name)` and the `zym --dump` output.
     */
    disassemble(chunk, name = "chunk") {
        this._checkAlive();
        const M = this._M;
        const namePtr = _strToWasm(M, name);
        let strPtr = 0;
        try {
            strPtr = M._zjs_disassembleChunk(this._ptr, chunk._ptr, namePtr);
            if (!strPtr) throw new Error("disassemble failed");
            return M.UTF8ToString(strPtr);
        } finally {
            if (strPtr) M._zjs_freeString(strPtr);
            M._free(namePtr);
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
export { ZymValue, KIND, STATUS, STATE, CAUSE, Zym };
