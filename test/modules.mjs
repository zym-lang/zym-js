/*
 * modules.mjs -- multi-file compilation through the JS module hooks.
 *
 * The bridge asks JS for module source synchronously via `read(path)`, with
 * an optional `resolve(spec, importer)` deciding the canonical key. This
 * mirrors what the CLI's `Zym` native exposes, with the filesystem replaced
 * by whatever the host wants to serve.
 */
import Zym from "../js/zym.mjs";

let fails = 0;
const check = (c, l) => { console.log(`${c ? "[PASS]" : "[FAIL]"} ${l}`); if (!c) fails++; };

// --- a tiny in-memory "filesystem" ---------------------------------------
const files = new Map([
    ["math.zym",  `func double(n) { return n * 2 }\nfunc square(n) { return n * n }\nreturn { double, square }`],
    ["greet.zym", `func greet(who) { return "hello " + who }\nreturn { greet }`],
]);

const ENTRY = `
var m = import("math.zym")
var g = import("greet.zym")
func main() { return str("%n|%n|%s", m.double(21), m.square(5), g.greet("zym")) }
`;

// --- basic multi-module compile -------------------------------------------
{
    const vm = await Zym.newVM();
    const reads = [];
    const chunk = vm.compileWithModules(ENTRY, {
        file: "entry.zym",
        read: (p) => { reads.push(p); return files.get(p) ?? null; },
    });
    chunk.run();
    const out = vm.call("main");
    check(out === "42|25|hello zym", `imports resolve and run (${out})`);
    check(reads.length === 2, `read hook called once per module (${reads.join(", ")})`);
}

// --- resolve hook rewrites specifiers -------------------------------------
{
    const vm = await Zym.newVM();
    const seen = [];
    const chunk = vm.compileWithModules(
        `var m = import("@/math")\nfunc main(){ return m.double(4) }`,
        {
            file: "entry.zym",
            resolve: (spec, importer) => {
                seen.push([spec, importer]);
                return spec.startsWith("@/") ? spec.slice(2) + ".zym" : null;
            },
            read: (p) => files.get(p) ?? null,
        });
    chunk.run();
    check(vm.call("main") === 8, "resolve hook maps a custom specifier");
    check(seen.some(([s]) => s === "@/math"), `resolver saw the raw spec (${JSON.stringify(seen)})`);
}

// --- import introspection during the hooks --------------------------------
{
    const vm = await Zym.newVM();
    let caller = "unset", stack = null;
    vm.compileWithModules(`var m = import("math.zym")\nfunc main(){ return 1 }`, {
        file: "entry.zym",
        read: (p) => { caller = vm.importCaller(); stack = vm.importStack(); return files.get(p) ?? null; },
    });
    check(typeof caller === "string" || caller === null, `importCaller() works inside read (${caller})`);
    check(Array.isArray(stack) && stack.length > 0, `importStack() populated inside read (${JSON.stringify(stack)})`);
    check(vm.importStack().length === 0, "importStack() empty outside a hook");
}

// --- missing module is a clean error, not a crash -------------------------
{
    const vm = await Zym.newVM();
    vm.on("error", () => {});
    let threw = false;
    try {
        vm.compileWithModules(`var x = import("nope.zym")`, { file: "e.zym", read: () => null });
    } catch { threw = true; }
    check(threw, "unresolvable import raises rather than crashing");
}

// --- serialize a module-built program and reload it ------------------------
{
    const vm = await Zym.newVM();
    const chunk = vm.compileWithModules(ENTRY, { file: "entry.zym", read: (p) => files.get(p) ?? null });
    const bytes = vm.serialize(chunk);
    const vm2 = await Zym.newVM();
    const reloaded = vm2.loadBytecode(bytes);
    reloaded.run();
    check(vm2.call("main") === "42|25|hello zym", "module-built program survives a bytecode round-trip");
}

console.log(`\n=== ${fails === 0 ? "all module assertions passed" : fails + " FAILURES"} ===`);
process.exit(fails ? 1 : 0);
