/*
 * node-stability.mjs - regression coverage for the stability pass:
 *   1. A JS native that throws must surface as a thrown ZymError out of
 *      vm.run / vm.call (not a silent sentinel value).
 *   2. Using a ZymValue after its VM has been freed must throw a clear
 *      ZymError rather than read freed wasm memory.
 */
import Zym, { ZymError } from "../js/zym.mjs";

function assert(cond, msg) {
    if (!cond) { console.error("FAIL:", msg); process.exit(1); }
}

// --- 1. JS native throwing ---------------------------------------------------
{
    const vm = await Zym.newVM();
    vm.registerNative("boom()", () => { throw new Error("kaboom from JS"); });
    let caught = null;
    try { vm.run("boom();"); } catch (e) { caught = e; }
    assert(caught instanceof ZymError, "run() should throw ZymError when native throws");
    assert(
        /kaboom from JS/.test(caught.message) || caught.details.some(d => /kaboom from JS/.test(d.message)),
        "ZymError should carry the JS native's message (got: " + caught.message + ")");
    console.log("[ok] native-throw produces ZymError:", caught.message);

    // VM should still be usable after a handled runtime error.
    vm.registerNative("echo(x)", (x) => x.toJS());
    vm.run('var v = echo(42);');
    vm.free();
}

// --- 2. ZymValue after VM.free() --------------------------------------------
{
    const vm = await Zym.newVM();
    let captured = null;
    vm.registerNative("capture(v)", (v) => { captured = v; return null; });
    vm.run('capture([1, 2, 3]);');
    // `captured` is a borrowed wrapper; convert it to owned by re-decoding,
    // then hold on to something that should survive the free() boundary
    // only through defensive throw, not raw wasm access.
    vm.free();

    let err = null;
    try { captured.toJS(); } catch (e) { err = e; }
    assert(err instanceof ZymError, "toJS() after free should throw ZymError");
    assert(/freed/i.test(err.message), "error should mention freed VM (got: " + err.message + ")");
    console.log("[ok] use-after-free throws ZymError:", err.message);

    let err2 = null;
    try { captured.display(); } catch (e) { err2 = e; }
    assert(err2 instanceof ZymError, "display() after free should throw");
    console.log("[ok] display() after free throws");
}

console.log("=== stability regressions passed ===");
