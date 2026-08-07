# zym-js

JavaScript / WebAssembly bindings for the [Zym](https://github.com/zym-lang) scripting language. Load the wasm once, spin up one or more VMs, compile and run scripts, register JS functions as Zym natives, define globals, save/load bytecode, and call script functions from JS, all from a single ESM module that runs in Node, the browser, and Web Workers.

---

> **⚠️ Alpha software, `0.3.0-alpha.2`.** The JS API, native-signature grammar, value marshaling, and bytecode format are not stable and may change between alphas. Do not use in production. Don't persist bytecode produced by this version and expect it to load on later builds.
>
> The vendored `zym_core` here is ahead of the public `0.2.0` release. Some language surface described in this doc (notably the unified variadic-fallback native signature syntax) isn't yet on [zym-lang.org](https://zym-lang.org). Stability lands with the final `0.3.0` release.

---

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [Entry points](#entry-points)
  - [`Zym` (default, lazy singleton)](#zym-default-lazy-singleton)
  - [`createZym` (advanced factory)](#createzym-advanced-factory)
- [The `VM` class](#the-vm-class)
  - [`vm.run(source, options?)`](#vmrunsource-options)
  - [`vm.compile(source, options?)` / `chunk.run()`](#vmcompilesource-options--chunkrun)
  - [`vm.serialize(chunk)` / `vm.loadBytecode(bytes)`](#vmserializechunk--vmloadbytecodebytes)
  - [`vm.defineGlobal(name, value)`](#vmdefineglobalname-value)
  - [`vm.call(funcName, ...args)`](#vmcallfuncname-args)
  - [`vm.hasFunc(name, arity?)` / `vm.getFunc(name)`](#vmhasfuncname-arity--vmgetfuncname)
  - [`vm.on("error", listener)`](#vmonerror-listener)
  - [`vm.free()`](#vmfree)
- [Registering native functions](#registering-native-functions)
  - [Signature grammar](#signature-grammar)
  - [Exact-arity natives](#exact-arity-natives)
  - [Variadic natives](#variadic-natives)
  - [Closures (capturing JS state)](#closures-capturing-js-state)
  - [Errors inside a native](#errors-inside-a-native)
- [Sandboxing](#sandboxing)
  - [Preemption entries](#preemption-entries)
  - [Stopping runaway code](#stopping-runaway-code)
  - [An event pump into the script](#an-event-pump-into-the-script)
  - [Capping memory](#capping-memory)
  - [Stopping on demand](#stopping-on-demand)
  - [Inspecting a stopped VM](#inspecting-a-stopped-vm)
  - [Resuming](#resuming)
  - [Budgeting the entry table](#budgeting-the-entry-table)
  - [Holding slots back from script](#holding-slots-back-from-script)
- [Values](#values)
  - [`ZymValue` wrapper](#zymvalue-wrapper)
  - [`toJS()` decoding rules](#tojs-decoding-rules)
  - [`display()` vs `toJS()`](#display-vs-tojs)
  - [Marshaling JS → Zym](#marshaling-js--zym)
- [Error handling](#error-handling)
- [Memory & lifetimes](#memory--lifetimes)
- [Using it in a project](#using-it-in-a-project)
  - [Node](#node)
  - [Browser (bundler)](#browser-bundler)
  - [Browser (no build)](#browser-no-build)
  - [Web Worker](#web-worker)
- [Bytecode](#bytecode)
- [Building from source](#building-from-source)
- [Running tests](#running-tests)
- [FAQ & gotchas](#faq--gotchas)

---

## Install

```bash
npm install @zym-lang/zym-js
```

The package ships the ESM entry (`js/zym.mjs`), TypeScript defs (`js/zym.d.ts`), and the wasm glue (`dist/zym_js.mjs` + `dist/zym_js.wasm`). No native build step is required at install time.

---

## Quick start

```js
import Zym from "@zym-lang/zym-js";

const vm = await Zym.newVM();

vm.registerNative("print(a)", (a) => {
    console.log(a.toJS());
    return null;
});

vm.run(`
    var message = "I like pie!";
    print(message);
`);

vm.free();
```

That's the entire happy path. One import, one `await`, one `vm`, one `free()` when you're done.

---

## Core concepts

- **One wasm module, many VMs.** The wasm is loaded lazily on first use and shared across every `Zym.newVM()` call. Each VM has its own heap, globals, and GC.
- **JS drives; Zym executes.** You compile or run scripts from JS. Scripts can call back into JS via natives.
- **Values cross the boundary as wrappers.** When a Zym value reaches JS (e.g., a native's arguments), you receive a `ZymValue` wrapper. Call `.toJS()` to get a natural JS value, or pass the wrapper straight back to Zym.
- **No manual rooting.** The bridge anchors every live handle in a hidden VM map and releases it via `FinalizationRegistry` when the JS wrapper is collected. You never touch `pushRoot` / `popRoot`.
- **Synchronous execution.** `vm.run`, `vm.call`, and native callbacks are synchronous. (Async/preemption is on the roadmap.)

---

## Entry points

### `Zym` (default, lazy singleton)

```js
import Zym from "@zym-lang/zym-js";

const vm  = await Zym.newVM();       // loads wasm on first call, cached afterwards
const ver = await Zym.version();     // version string from the wasm
await Zym.ready();                   // optional: warm up the wasm ahead of time
```

This is the recommended entry point. The wasm is instantiated once behind the scenes; every `newVM()` reuses the shared module. Import is side-effect-free.

### `createZym` (advanced factory)

```js
import { createZym } from "@zym-lang/zym-js";

const zym = await createZym({ locateFile: (f) => `/wasm/${f}` });
const vm  = zym.newVM();
```

Use this when you need an **isolated wasm instance** (e.g., two concurrent VMs with separate memories) or want to pass custom Emscripten options (`locateFile`, `wasmBinary`, `print`, `printErr`, …). Each call to `createZym` loads a fresh module.

---

## The `VM` class

Every method throws `ZymError` on compile/runtime failure. The `vm` object is opaque; treat it as a handle.

### `vm.run(source, options?)`

Compile and execute a source string in one call.

```js
vm.run(`print("hello");`);
vm.run(source, { file: "user-script.zym", includeLineInfo: true });
```

- `options.file`: filename shown in errors (default `"<script>"`).
- `options.includeLineInfo`: keep line debug info in the compiled chunk (default `true`).

### `vm.compile(source, options?)` / `chunk.run()`

Compile once, run many times.

```js
const chunk = vm.compile(`print("hi");`, { file: "preamble.zym" });
chunk.run();
chunk.run();
chunk.free();        // optional; GC releases it otherwise
```

### `vm.serialize(chunk)` / `vm.loadBytecode(bytes)`

```js
const bytes = vm.serialize(chunk);            // Uint8Array
// ...ship bytes to disk, localStorage, IndexedDB, fetch...
const reloaded = vm.loadBytecode(bytes);      // accepts Uint8Array or ArrayBuffer
reloaded.run();
```

Bytecode is Zym's own binary format. See [Bytecode](#bytecode) for stability notes.

### `vm.defineGlobal(name, value)`

Expose a JS value as a Zym global.

```js
vm.defineGlobal("PI",      Math.PI);
vm.defineGlobal("USER",    "ada");
vm.defineGlobal("CONFIG",  { debug: true, limits: [1, 2, 3] });
vm.defineGlobal("onHover", (x) => { /* see registerNative for real callbacks */ });
```

JS values are marshaled into Zym (see [Marshaling JS → Zym](#marshaling-js--zym)). Globals defined this way are reassignable from script.

### `vm.call(funcName, ...args)`

Invoke a Zym function from JS. Arguments are auto-marshaled; the return value is decoded via `toJS()`-style rules.

```js
vm.run(`fun add(a, b) { return a + b; }`);
const sum = vm.call("add", 2, 3);   // 5
```

### `vm.callValue(callable, args?)`

Invoke an arbitrary callable value (Zym function or closure) held by a `ZymValue` wrapper or raw handle. This is the substrate behind the callable returned by `ZymValue.toJS()` for functions/closures; you rarely need to call it directly.

```js
vm.run(`func makeAdder(n) { return func(x) { return x + n; }; }`);
const add10 = vm.call("makeAdder", 10);   // decoded as a JS callable
add10(5);                                  // 15  (uses callValue under the hood)
```

### `vm.hasFunc(name, arity?)` / `vm.getFunc(name)`

Find out whether a script defines something before you call it.

`hasFunc` with one argument is true if *any* callable by that name exists, at any arity. With two, it asks whether a call with exactly that many arguments would dispatch, which includes a variadic whose fixed prefix is short enough.

```js
vm.run(`func main(...args) { return length(args) }`);

vm.hasFunc("main");          // true
vm.hasFunc("main", 3);       // true  -- variadic accepts 3
vm.hasFunction("main", 3);   // false -- strict exact-slot probe
```

That last line is why `hasFunc` exists: `hasFunction` matches a fixed arity slot exactly, so it misses a variadic entry point. Use `hasFunc` for discovery, `hasFunction` when you mean a precise signature.

`getFunc` returns a reusable callable, or `null` if there is no such function. The name is resolved once and the result is identity-stable, so it works as a `Map` key.

```js
const main = vm.getFunc("main");
if (main) main(1, 2, 3);

vm.getFunc("main") === main;   // true
```

### `vm.on("error", listener)`

Subscribe to compile and runtime errors as a stream. Fires in addition to the thrown `ZymError` (useful for logging multiple diagnostics from a single compile).

```js
const off = vm.on("error", (e) => {
    console.warn(`[${e.file}:${e.line}] ${e.message}`);
});
// ...
off();    // unsubscribe
```

### `vm.free()`

Release the VM and everything it owns. Safe to call multiple times. Recommended: a `FinalizationRegistry` will eventually clean up if you forget, but the JS GC makes no timing promises.

---

## Registering native functions

All natives are registered through a single method. Whether the function takes a fixed number of arguments or is variadic is controlled by the **signature string**, not by the API.

### Signature grammar

```
funcName(param1, param2, ..., paramN)        // fixed arity
funcName(param1, ...)                        // variadic (any number of extra args)
funcName(param1, ...rest)                    // variadic, rest param named
funcName(...)                                // fully variadic
funcName()                                   // zero-arg
```

Rules:

- Parameter names are documentation only. Zym's parser records the **count** and the **variadic flag**.
- `...` (optionally followed by a name) marks the native as variadic. It must be the last item.
- Fixed arity is 0 to 10 positional parameters. Variadic natives take 0 to 10 positional parameters followed by any number of trailing args.

### Exact-arity natives

```js
vm.registerNative("greet(name)", (name) => {
    return `hello, ${name.toJS()}`;
});

vm.registerNative("add(a, b)", (a, b) => {
    return a.toJS() + b.toJS();
});

vm.registerNative("now()", () => Date.now());
```

Arguments arrive as `ZymValue` wrappers. Return anything marshalable (primitives, arrays, plain objects, or another `ZymValue`). Returning `undefined` is treated as `null`.

### Variadic natives

```js
vm.registerNative("log(level, ...parts)", (level, ...parts) => {
    console.log(`[${level.toJS()}]`, ...parts.map((p) => p.toJS()));
    return null;
});

vm.registerNative("sum(...xs)", (...xs) => {
    return xs.reduce((acc, v) => acc + v.toJS(), 0);
});
```

The rest parameters appear as a JS spread of `ZymValue` wrappers, exactly like a normal JS variadic function.

### Closures (capturing JS state)

Natives are just JS functions, so they close over variables naturally. No special API.

```js
function makeCounter() {
    let n = 0;
    return () => { n += 1; return n; };
}

vm.registerNative("tick()", makeCounter());
vm.run(`print(tick()); print(tick()); print(tick());`);   // 1 2 3
```

Any JS callable works: arrow functions, bound methods, class instance methods, etc.

### Errors inside a native

Throwing from a native surfaces to the script as a Zym runtime error, which also propagates out as a `ZymError` from `vm.run` / `vm.call`.

```js
vm.registerNative("parseJSON(src)", (src) => {
    try   { return JSON.parse(src.toJS()); }
    catch (e) { throw new Error(`bad json: ${e.message}`); }
});
```

---

## Sandboxing

Running code you did not write means being able to take control back from it. A script can loop forever, allocate without end, or simply take longer than you are willing to wait, and none of that should be able to hang the page or exhaust the tab.

zym-js gives you three bounds, all of which **suspend** the VM rather than destroy it: the frames, stack, and instruction pointer stay intact, so you can inspect what happened and continue if you want to.

### Preemption entries

A preemption entry says "hand control back every N instructions". Slices count VM instructions, not milliseconds, so they are deterministic and machine-independent.

```js
const id = vm.addPreempt(slice, handler?, options?);
vm.removePreempt(id);
vm.setPreemptSlice(id, slice);   // retune its cadence
```

Two options, both off by default:

| | |
| --- | --- |
| `once` | retire after firing instead of rearming — a deadline rather than a repeating tick |
| `maskable` | a script may suppress it with `Preempt.shield`; without this it always fires |

`once` is the `addEventListener` sense of the word, and the entry frees its slot as it fires. Note that it stops bounding the run once it has gone off, so it is not a watchdog over unbounded code — for that you want a rearming entry, which is the default.

Leaving `maskable` off is what makes a watchdog a watchdog: script cannot shield itself from it.

Whether you pass a handler is the whole distinction:

| | |
| --- | --- |
| **with a handler** | it runs, then execution continues automatically |
| **without one** | there is nothing to run, so the VM stays suspended and `run()` throws `ZymSuspended` |

Entries are independent. You can have several at different slices, each with its own handler, and each is addressed by its own id. The table holds 32 per VM; `addPreempt` throws if it is full.

### Stopping runaway code

An entry with no handler is the simplest thing you can build: a hard bound on how long a script may run.

```js
const vm = await Zym.newVM();
vm.addPreempt(1_000_000);                     // no handler: hand control back

try {
    vm.run(`var i = 0
while (true) { i = i + 1 }`);
} catch (e) {
    if (e instanceof ZymSuspended) {
        console.log("stopped:", e.cause === CAUSE.PREEMPT ? "ran too long" : "other");
    } else throw e;
}
```

```
stopped: ran too long
```

`ZymSuspended` is deliberately not the same as `ZymError`. One means *you* stopped it, the other means it failed on its own, and you almost always want to report those differently.

### An event pump into the script

Give the entry a handler and it becomes something more useful than a limit: a periodic hook. The handler may call into the parked VM, so a script can expose its own trigger and let the host drive it.

```js
const vm = await Zym.newVM();

vm.addPreempt(200_000, () => {
    vm.call("onTick");                        // the script's own hook
});

vm.run(`
var beats = 0
func onTick() { beats = beats + 1 }

var total = 0
var i = 0
while (i < 1000000) { total = total + i
 i = i + 1 }
func beatCount() { return beats }
`);

console.log("script saw", vm.call("beatCount"), "ticks");
```

```
script saw 50 ticks
```

The script's own state is untouched by the calls, and it runs to completion normally. This is also the only moment JS code runs while a script executes: everything is synchronous, so nothing else gets a turn until the script finishes or an entry fires.

A handler may call into the VM, register or remove entries, request a stop, or free the VM. It may **not** start a nested `run()` or `resume()`; those throw.

### Capping memory

The counterpart to bounding time. `0`, the default, means unlimited.

```js
vm.setMemoryLimit(vm.memoryUsed() + 1024 * 1024);   // +1 MiB

try {
    vm.run(`var hoard = []
var i = 0
while (true) { push(hoard, [i, i])
 i = i + 1 }`);
} catch (e) {
    if (e.cause === CAUSE.MEMORY_LIMIT) {
        console.log("hit the ceiling wanting", e.bytesWanted, "more bytes");
    }
}
```

```
hit the ceiling wanting 64 more bytes
```

Crossing the ceiling does not fail the allocation, it suspends afterwards, so the VM is consistent and you decide what happens: grant more room with another `setMemoryLimit`, or discard it. Raising the limit above current usage clears the condition on its own. Garbage is never charged against the budget, only what the script retains.

Size the limit relative to `vm.memoryUsed()` on a fresh VM rather than picking an absolute number, since a new VM already carries its own runtime footprint.

### Stopping on demand

```js
vm.requestStop();       // sticky and unmaskable
vm.stopRequested();     // true
vm.clearStop();         // before reusing the VM
```

A stop outranks everything else and nothing in the script can suppress it. It is sticky by design: the VM stays suspended until you clear it.

### Inspecting a stopped VM

`vm.info()` is one snapshot, taken together so the fields cannot disagree.

```js
const i = vm.info();
i.state === STATE.SUSPENDED;   // paused, frames intact
i.cause === CAUSE.PREEMPT;     // why
i.resumable;                   // would resume() get anywhere
```

`STATE` is what the VM *is*: `IDLE`, `RUNNING`, `SUSPENDED`, `FAILED`. `CAUSE` is why: `PREEMPT`, `HOST_STOP`, `MEMORY_LIMIT`, `OUT_OF_MEMORY`, `RUNTIME_ERROR`, and a few more.

They are separate on purpose. Every pause looks the same as a state; the cause is what tells you whether to grant more time, grant more memory, or give up. A *failure* is `FAILED`, never `SUSPENDED`, so it can never be mistaken for something to continue.

Read `resumable` rather than working it out yourself. A preemption leaves the VM immediately continuable; a stop and a memory ceiling are both sticky and read `false` until cleared. That single field is the difference between a loop that makes progress and one that spins.

### Resuming

```js
vm.resume();
```

Continues a suspended VM, returning once the script completes, throwing `ZymSuspended` if it pauses again and `ZymError` if it fails. Whatever suspended it has to be cleared first, which is what `resumable` tells you.

You rarely call it directly: an entry *with* a handler resumes for you, so slicing a long script into chunks and reporting progress is just a handler that returns `true`.

```js
const started = Date.now();
let ticks = 0;

vm.addPreempt(100_000, () => {
    ticks++;
    return Date.now() - started < 2000;        // false stops the run
});

vm.run(`var total = 0
var i = 0
while (i < 2000000) { total = total + i
 i = i + 1 }
func total_() { return total }`);

console.log("finished after", ticks, "ticks, total =", vm.call("total_"));
```

```
finished after 200 ticks, total = 1999999000000
```

Returning `false` from a handler stops instead of resuming, which is how you express a wall-clock deadline: the clock is only checked when a handler runs, so the granularity is your slice size.

### Budgeting the entry table

The table is shared: entries you register from JS and entries the script registers for itself with `Preempt.every` come out of the same 32 slots. `vm.preempts()` is one snapshot of it, taken together so the numbers cannot disagree.

```js
const t = vm.preempts();
t.capacity          // 32, fixed at build time
t.used / t.free     // used + free === capacity
t.hostUsed          // registered through addPreempt
t.scriptUsed        // registered by the script itself
t.reserve           // slots held back from script
t.scriptCapacity    // capacity - reserve
t.scriptAvailable   // what script could still take right now
t.entries           // [{ id, remaining, handler }, ...]
```

`remaining` counts instructions until that entry fires. `handler` is whether *this VM* has a JS function bound to that id, which is exactly the difference between an entry that resumes itself and one that suspends — so script-registered entries always read `false`.

For a single entry, `vm.preemptRemaining(id)` answers the same question without building the array, which is what makes it usable from inside a handler retuning its own cadence. An unknown id reads `-1`, so it doubles as a liveness check.

`vm.triggerPreempt(id)` arms an entry to fire at the next instruction instead of when its countdown runs out. Since nothing else in JS runs while a script does, this is not a way to interrupt from outside: use it from inside another entry's handler, or between `run()` and `resume()`.

### Holding slots back from script

A script that registers entries until the table is full leaves you unable to arm a watchdog over it. The reserve is the fix:

```js
vm.setPreemptReserve(2);   // 2 slots script can never take
vm.preemptReserve();       // read it back
```

It is a floor for you and a ceiling for script — you are never restricted to the reserve, script simply cannot spend it. It also locks once the VM executes anything, which is what lets a script treat the budget it sees at the start as still bindable at the end. Calling it after the VM has run throws.

```js
const vm = await Zym.newVM();
vm.setPreemptReserve(2);                      // keep 2 slots for the host

vm.addPreempt(1_000_000);                     // spend one of them

vm.run(`
func tick() {}
Preempt.every(250000, tick)
`);

const t = vm.preempts();
console.log(`table  ${t.used}/${t.capacity} used, ${t.free} free`);
console.log(`owners host ${t.hostUsed}, script ${t.scriptUsed}`);
console.log(`script may still take ${t.scriptAvailable} of ${t.scriptCapacity}`);
for (const e of t.entries) {
    console.log(`  #${e.id} fires in ${e.remaining}, handler: ${e.handler}`);
}
```

```
table  2/32 used, 30 free
owners host 1, script 1
script may still take 29 of 30
  #1 fires in 1000000, handler: false
  #2 fires in 250000, handler: false
```

`scriptAvailable` is 29 rather than 30 because the script already spent one, and it is bounded by the real free slots as well as script's own budget — if you overspend your reserve, script's figure drops to match what actually exists rather than promising room that is gone. It is the same number the script reads from `Preempt.available()`, so host and script never disagree about how much is left.

`preemptCapacity()`, `preemptUsed()` and `preemptReserve()` remain as direct single-value reads if you only want one of them.

---

## Values

### `ZymValue` wrapper

Every value arriving from Zym (native args, script return values) is wrapped. The wrapper exposes:

| Member | Description |
|---|---|
| `kind` | Numeric kind code; compare against the `KIND` export |
| `isNull()` / `isBool()` / `isNumber()` / `isString()` / `isList()` / `isMap()` / `isCallable()` | Convenience type-checks |
| `toJS()` | Decode into a natural JS value (see next section) |
| `display()` | VM-formatted string (same output as a Zym `print`) |
| `toString()` | Alias of `display()`; safe to use in template literals |
| `dispose()` | Release the underlying handle eagerly (optional) |

You can also pass a `ZymValue` back to any API that accepts marshaled input (`defineGlobal`, `call`, native return value); it's forwarded without copying.

### `toJS()` decoding rules

`toJS()` produces the most natural JS shape for each Zym kind:

| Zym kind | JS result |
|---|---|
| `null` | `null` |
| `bool` | `boolean` |
| `number` | `number` |
| `string` | `string` |
| `list` | `Array` (elements decoded recursively) |
| `map` | plain `Object` (values decoded recursively) |
| `struct` | plain `Object` with a non-enumerable `__type` string (declared type name) |
| `enum variant` | frozen `{ __enum, name, ordinal }` |
| `function` / `closure` | a callable JS function; invoking it calls back into the VM. Exposes `.free()` / `[Symbol.dispose]` for deterministic cleanup (otherwise GC releases it). |
| `continuation` / anything else | the `ZymValue` wrapper unchanged |

Cycles in maps/structs are preserved via shared references (no infinite recursion).

Callables returned from `toJS()` own their own handle, so they stay valid after the original `ZymValue` or result handle is gone. They are invoked with plain JS args which are auto-marshaled; the return value is decoded with the same rules as the rest of the table.

```js
vm.run(`fun make() { return (x) => x * x; }`);
const sq = vm.call("make");          // sq is a JS function
sq(7);                                 // 49
sq.free();                             // optional; GC also handles it
```

### `display()` vs `toJS()`

- `toJS()`: "give me the JS form I can program against." Use this in `print` natives, logging, assertions, anywhere you'd normally touch a JS value.
- `display()`: "give me the VM's canonical text form," identical to what a Zym script would print. Useful for format-aware `print` implementations that want to match core parity.

Both are safe on every kind. Prefer `toJS()` unless you specifically need VM formatting.

### Marshaling JS → Zym

When you hand a JS value to `defineGlobal`, `vm.call`, or a native's return value, the bridge converts:

| JS value | Zym value |
|---|---|
| `null` / `undefined` | `null` |
| `boolean` | `bool` |
| `number` / `bigint` (that fits in double) | `number` |
| `string` | `string` |
| `Array` | `list` (elements marshaled recursively) |
| plain `Object` | `map` (values marshaled recursively) |
| `ZymValue` | passed through unchanged |
| other (functions, class instances, etc.) | rejected; register functions as natives instead |

---

## Error handling

All VM operations that can fail throw `ZymError`.

```js
import Zym, { ZymError } from "@zym-lang/zym-js";

const vm = await Zym.newVM();
try {
    vm.run("var x = ;");    // syntax error
} catch (e) {
    if (e instanceof ZymError) {
        console.error(e.status);      // e.g. STATUS.COMPILE_ERROR
        console.error(e.details);     // [{ status, file, line, message }, ...]
    } else {
        throw e;
    }
}
```

- `e.status`: status code; compare against the `STATUS` named export.
- `e.details`: one entry per diagnostic emitted by the VM. Compile failures often yield multiple.
- The same diagnostics also stream through `vm.on("error", ...)` if you subscribe.

---

## Memory & lifetimes

You should not need to think about memory at all in typical use. Here's what the bridge does for you:

- **`ZymValue` wrappers** are tied to a `FinalizationRegistry`; when JS collects the wrapper, the underlying Zym handle is released.
- **Native arguments** are scoped to the call. They're released automatically when the native returns, unless you kept a JS reference alive (in which case they survive for the wrapper's lifetime).
- **JS callbacks you register as natives** live in an id-keyed registry. The Zym GC decides when a native closure is unreachable and notifies the bridge to drop the entry.
- **Globals and script functions** are rooted by the VM itself.

The one place determinism matters is VM teardown: call `vm.free()` when you're done, because finalizers may not fire before process exit. If you forget, the bridge's own teardown walks and releases every outstanding handle.

If you hold on to a `ZymValue` past `vm.free()`, using it (`toJS`, `display`, `kind`, etc.) throws a `ZymError` (`"ZymValue used after its VM was freed"`) instead of reading freed wasm memory.

For advanced users who care about peak memory, `ZymValue.dispose()` releases a handle eagerly.

---

## Using it in a project

### Node

Node 16+ with ESM. In your `package.json`:

```json
{ "type": "module" }
```

Then:

```js
import Zym from "@zym-lang/zym-js";
const vm = await Zym.newVM();
vm.run(`/* ... */`);
vm.free();
```

Dynamic-`import()` works from CJS too:

```js
const { default: Zym } = await import("@zym-lang/zym-js");
```

### Browser (bundler)

Vite, Next.js, Rollup, Webpack 5, esbuild all handle ESM + wasm natively. Nothing special required.

```js
import Zym from "@zym-lang/zym-js";

export async function runUserScript(src) {
    const vm = await Zym.newVM();
    vm.registerNative("print(a)", (a) => { console.log(a.toJS()); });
    try { vm.run(src); } finally { vm.free(); }
}
```

### Browser (no build)

Drop the two files (`zym.mjs` and the `dist/` pair) into your static assets and import via `<script type="module">`:

```html
<script type="module">
  import Zym from "./js/zym.mjs";
  const vm = await Zym.newVM();
  vm.registerNative("print(a)", (a) => { console.log(a.toJS()); });
  vm.run(`print("hi from the browser");`);
  vm.free();
</script>
```

See `examples/browser-hello.html` in the repo for a working single-page demo.

### Web Worker

The wasm module declares `ENVIRONMENT=web,node,worker`, so `zym.mjs` works unmodified inside a `Worker`. Recommended for long-running scripts so they don't block the main thread:

```js
// worker.js
import Zym from "./js/zym.mjs";

self.onmessage = async (e) => {
    const vm = await Zym.newVM();
    try {
        vm.run(e.data.source);
        self.postMessage({ ok: true });
    } catch (err) {
        self.postMessage({ ok: false, error: err.message });
    } finally {
        vm.free();
    }
};
```

```js
// main.js
const worker = new Worker("./worker.js", { type: "module" });
worker.postMessage({ source: `print("from worker");` });
```

---

## Bytecode

```js
const chunk = vm.compile(src);
const bytes = vm.serialize(chunk);            // Uint8Array
const reloaded = vm.loadBytecode(bytes);
reloaded.run();
```

Zym bytecode carries a magic header. Pre-1.0.0, the format version is held constant; cross-version compatibility guarantees will land with the 1.0 release. For now:

- Bytecode produced by a given `zym-js` build is loadable by the same build.
- Don't rely on bytecode portability across versions until 1.0.

---

## Building from source

The build sets the VM's limits above the core defaults, which are sized for microcontrollers: 4096 call frames, a 262144-slot value stack, and 32 preemption entries per VM. Each is a CMake cache variable, so a constrained target can dial them back without editing anything:

```sh
emcmake cmake -S . -B cmake-build-wasm -DZYM_FRAMES_MAX=256 -DZYM_PREEMPT_MAX_ENTRIES=8
```

Changing them needs a fresh configure; a plain rebuild reuses the cached definitions.

Needs [Emscripten](https://emscripten.org/) on your PATH (`emsdk_env.sh`) plus CMake ≥ 3.20.

```bash
emcmake cmake -S . -B cmake-build-wasm
cmake --build cmake-build-wasm --target zym_js
```

Output lands in `dist/zym_js.mjs` + `dist/zym_js.wasm`, which `js/zym.mjs` imports.

---

## Running tests

```bash
node test/node-smoke.mjs           # JS-API smoke test (fast)
node test/run-core-tests.mjs       # regression suite over core_tests/*.zym (with pass/fail summary)
node test/run-core-tests-raw.mjs   # same suite, streams each script's raw output only
```

Add `--verbose` to `run-core-tests.mjs` for full per-test output on failures.

---

## FAQ & gotchas

**Q: Do I have to call `vm.free()`?**
No, but you should. `FinalizationRegistry` will release a forgotten VM eventually, but the JS GC makes no timing promises, and peak memory can grow before cleanup fires.

**Q: Can I run two VMs at once?**
Yes. `Zym.newVM()` can be called as many times as you like; each returns an independent VM sharing the same wasm module. If you need independent *wasm heaps*, use `createZym()` twice instead.

**Q: Can I call `vm.run` from inside a native?**
Yes. The bridge is re-entrant; handles stay properly rooted across nested calls.

**Q: `JSON.stringify(someZymValue)` hangs / crashes. Why?**
Don't stringify a wrapper directly; it carries a back-reference to the wasm `Module`, whose HEAP TypedArrays are huge. Call `.toJS()` first, then `JSON.stringify` the decoded value. `String(wrapper)` and template literals are fine; they route through `display()`.

**Q: A native returns `undefined`. What does Zym see?**
`null`. Any missing return is normalized.

**Q: Can a native return a function?**
Not directly in Pass 1. Returning a JS function from a native isn't auto-wrapped into a Zym closure yet. Register it as a native up front via `registerNative` and expose it by name.

**Q: How do I hook `print`?**
Zym ships no default print; every embedder wires its own. The simplest version:

```js
vm.registerNative("print(...parts)", (...parts) => {
    console.log(parts.map((p) => p.toJS()).join(" "));
    return null;
});
```

For format-spec parity with the native `print.c`, see `test/run-core-tests.mjs` for a reference implementation.

**Q: What happens if I register two natives with the same name and same arity?**
The second registration replaces the first (same as the core C API). Overloading by arity (`foo(a)` and `foo(a, b)`) is supported; Zym dispatches on arity.

**Q: Is async / preemption supported?**
Not in this release. Scripts run synchronously. Cooperative async via `zym_setPreemptCallback` is planned but gated on the core-side preemption model landing first.
