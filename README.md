<p align="center">
  <h1 align="center">zym-js</h1>
  <p align="center"><strong>Zym in JavaScript. No ceremony.</strong></p>
  <p align="center"><em>WebAssembly bindings for the <a href="https://github.com/zym-lang">Zym</a> scripting language.</em></p>
  <p align="center">
    Drop a safe, fast scripting sandbox into any JavaScript project. Works in Node, the browser, Web Workers, bundlers, or a single HTML file.
  </p>
</p>

---

> **`0.3.0`.** The JS API, native-signature grammar, and value marshaling are stable for this release.
>
> Bytecode is portable across builds of `0.3.0`, but the format changed since `0.2.0`: artifacts produced by earlier versions do not load.

---

If you've used Zym from C, this is the same VM, same bytecode, same semantics, just reachable from `import`.

```js
import Zym from "@zym-lang/zym-js";

const vm = await Zym.newVM();

vm.registerNative("print(a)", (a) => { console.log(a.toJS()); return null; });

vm.run(`
    func fib(n) {
        if (n < 2) return n;
        return fib(n - 1) + fib(n - 2);
    }
    print(fib(10));   // 55
`);

vm.free();
```

```js
// JS natives, including variadic, including closures
vm.registerNative("sum(...nums)", (...args) => {
    let total = 0;
    for (const v of args) total += v.toJS();
    return total;
});

vm.registerNative("makeCounter(start)", (start) => {
    let n = start.toJS();
    return () => n++;              // returning a JS function becomes a Zym callable
});
```

```js
// Talk to the VM from JS
vm.defineGlobal("PI", Math.PI);

vm.run(`func area(r) { return PI * r * r; }`);

const result = vm.call("area", 2);
console.log(result.toJS());        // 12.566...
```

## Why zym-js?

- **Zym is a small, embeddable scripting language.** Its own language, its own VM, its own bytecode. Designed for embedding into host applications and giving them a controllable scripting surface.
- **JS-like syntax, so you don't context-switch.** The grammar reads like JavaScript. Flipping between host code and script doesn't re-train your fingers, and the semantics stay the VM's (not JS's), so no surprise coercions bleed into your host.
- **One import, one call.** `await Zym.newVM()` and you're running scripts. The wasm is loaded lazily and cached; there is no build step at install time.
- **Runs everywhere modern JS runs.** Node 16+, every evergreen browser, Web Workers, Vite, Next.js, Rollup, Webpack 5. No Node-only APIs, no `SharedArrayBuffer` required.
- **JS-native natives.** Register any JS function as a Zym native, including closures that capture outer JS state. Variadic and exact-arity both supported under one signature grammar.
- **GC just works.** The bridge manages rooting, handle lifetimes, and finalizers. JS devs do not push/pop roots or release values. Forget a value and the JS GC cleans it up.
- **Natural values.** `zymValue.toJS()` returns real JS: numbers, strings, booleans, `null`, arrays for lists, plain objects for maps, tagged objects for structs, frozen `{__enum, name, ordinal}` for enum variants.
- **Bytecode in, bytecode out.** Compile once, ship a `Uint8Array`, load it anywhere. Same bytecode as native Zym.
- **Sandboxed.** A JavaScript environment without a general-purpose scripting sandbox is a problem Zym is well-suited to solve. The VM cannot see anything you do not hand it.
- **TypeScript.** First-class `.d.ts` ships in the package.

## Install

```bash
npm install @zym-lang/zym-js
```

The package ships:

- `js/zym.mjs`: ESM entry (default export `Zym`, named `createZym`, `ZymValue`, `ZymError`)
- `js/zym.d.ts`: TypeScript defs
- `dist/zym_js.mjs` + `dist/zym_js.wasm`: Emscripten glue + wasm binary

No native compilation is triggered on install.

## Quick start

### Node / bundler

```js
import Zym from "@zym-lang/zym-js";

const vm = await Zym.newVM();
vm.registerNative("print(a)", (a) => { console.log(a.toJS()); return null; });
vm.run(`print("hello from zym");`);
vm.free();
```

### Browser, no build

```html
<script type="module">
    import Zym from "./node_modules/@zym-lang/zym-js/js/zym.mjs";

    const vm = await Zym.newVM();
    vm.registerNative("print(a)", (a) => { document.body.append(a.toJS() + "\n"); return null; });
    vm.run(`print("hello from zym");`);
</script>
```

### Multiple isolated instances (advanced)

```js
import { createZym } from "@zym-lang/zym-js";

const zym = await createZym({ locateFile: (f) => `/custom/path/${f}` });
const vm  = zym.newVM();
```

## API at a glance

| Surface | What it does |
|---|---|
| `Zym.newVM()` | Lazily instantiates the wasm (once) and returns a fresh VM. |
| `Zym.ready()` | Eagerly warms up the wasm module without creating a VM. |
| `Zym.version()` | Returns the `zym_core` version string. |
| `vm.run(src, opts?)` | Compile and run a script. Returns a `ZymValue` for the last expression (if any). |
| `vm.compile(src, opts?)` | Returns a `Chunk` for re-running without recompiling. |
| `vm.serialize(chunk)` | → `Uint8Array`. Portable bytecode. |
| `vm.loadBytecode(bytes)` | → `Chunk`. Inverse of `serialize`. |
| `vm.defineGlobal(name, value)` | Expose a JS value (auto-marshaled) as a Zym global. |
| `vm.registerNative(sig, fn)` | Register a JS function as a Zym native. |
| `vm.call(name, ...args)` | Call a Zym script function from JS. |
| `vm.hasFunc(name, arity?)` / `vm.getFunc(name)` | Find out whether a script defines something before calling it. |
| `vm.on("error", cb)` | Stream VM errors (compile and runtime) to a listener. |
| `vm.free()` | Explicitly release VM memory. Optional; a `FinalizationRegistry` will clean up forgotten VMs. |

Bounding untrusted code — all of these **suspend** the VM rather than destroy it, so you can inspect and continue:

| Surface | What it does |
|---|---|
| `vm.addPreempt(slice, handler?, opts?)` | Hand control back every `slice` instructions. With a handler it resumes automatically; without one the run suspends. |
| `vm.removePreempt(id)` / `vm.setPreemptSlice(id, slice)` | Drop an entry, or retune its cadence. |
| `vm.setMemoryLimit(bytes)` | Cap how much the VM may allocate. Crossing it suspends instead of failing the allocation. |
| `vm.requestStop()` / `vm.clearStop()` | Unmaskable, sticky stop. |
| `vm.info()` | One snapshot: what the VM is, why, and whether `resume()` would get anywhere. |
| `vm.resume()` | Continue a suspended VM. |
| `vm.preempts()` | One snapshot of the entry table: capacity, ownership split, and what script may still take. |
| `vm.setPreemptReserve(n)` | Hold slots back so a watchdog can still be armed after script has been running. |

Full details, signature grammar, marshaling rules, memory semantics, error handling, and recipes are in **[doc.md](./doc.md)**.

## What's in a native signature

The bridge accepts the same signature grammar as `zym_core`:

```js
vm.registerNative("add(a, b)",          (a, b) => a.toJS() + b.toJS());
vm.registerNative("sum(...nums)",       (...xs) => xs.reduce((s, v) => s + v.toJS(), 0));
vm.registerNative("greet(name, ...tags)", (name, ...tags) => { /* ... */ });
```

An identifier starting with `...` marks a variadic tail (with or without a trailing name). Everything before it is fixed-arity. That's the whole grammar.

## Values

JS ↔ Zym marshaling is automatic in both directions:

| JS | Zym |
|---|---|
| `number` | `number` |
| `string` | `string` |
| `boolean` | `bool` |
| `null` / `undefined` | `null` |
| `Array` | `list` (recursive) |
| plain `Object` | `map` (recursive) |
| `Uint8Array` | passed as bytecode to `loadBytecode` only |
| `Function` | becomes a callable Zym value via the native trampoline |
| `ZymValue` | passthrough (no conversion) |

Coming back out, `ZymValue.toJS()` produces the natural JS shape for every Zym kind (lists become arrays, maps become objects, structs become objects with a `__type` tag, enum variants become `{__enum, name, ordinal}`, primitives stay primitive). Cycles are preserved. `ZymValue.display()` is available when you want the VM's canonical printed form (what `print` would show).

## Running the tests

```bash
# Build the wasm (needs Emscripten on PATH: `source /path/to/emsdk_env.sh`)
npm run build

# Smoke test: JS API surface
npm run test:smoke

# Regression suite: every core_tests/*.zym run through the bridge
npm run test:regressions

# Both
npm test
```

The regression driver mirrors the `print` native from `zym_core/src/natives/print.c` in JS so the same scripts that pass under the native CLI pass here.

## Building from source

```bash
emcmake cmake -S . -B cmake-build-wasm
cmake --build cmake-build-wasm --target zym_js
```

Outputs `dist/zym_js.{mjs,wasm}`. The CMake profile is also registered in CLion as `WASM`.

## Documentation

- **[doc.md](./doc.md)**: the full zym-js API reference (entry points, `VM` class, native registration, values, errors, memory, recipes, FAQ).
- **[zym-lang.org](https://zym-lang.org)**: the language guide and core library docs.
- **[Playground](https://zym-lang.org/playground.html)**: try Zym in the browser.

## Project structure

```
zym-js/
├── src/               C shim layer (zym_js_api.{h,c}) + smoke main
├── js/                JS wrapper (zym.mjs) and TypeScript defs (zym.d.ts)
├── dist/              Built wasm artifacts
├── zym_core/          Upstream Zym (submodule / vendored)
├── test/              node-smoke.mjs + run-core-tests{,raw}.mjs
├── core_tests/        Regression suite (.zym scripts)
├── examples/          browser-hello.html
├── doc.md             Full user-facing API documentation
└── package.json
```

## Status

`0.3.0` is the current release.

- Bytecode is portable between builds of `0.3.0`. The format changed since `0.2.0`, so artifacts from earlier versions do not load — recompile from source.
- The native signature grammar includes the variadic-fallback form; scripts authored against it will not compile on `0.2.0`.
- Preemption is exposed from JS as of this release; see [Sandboxing](./doc.md#sandboxing). Everything is synchronous — there is no async surface, and no JS runs while a script does except a preemption handler.

## License

MIT. See [LICENSE](LICENSE).
