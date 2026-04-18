/*
 * node-pass2.mjs - regression coverage for Pass 2 of toJS() naturalization:
 * Zym FUNCTION/CLOSURE values decode to callable JS functions, and a matching
 * `vm.callValue(handle, args)` substrate lets user code invoke callable
 * handles directly.
 */
import Zym, { ZymError } from "../js/zym.mjs";

function assert(cond, msg) {
    if (!cond) { console.error("FAIL:", msg); process.exit(1); }
}

// --- 1. Script function returned to JS decodes to a JS callable -------------
{
    const vm = await Zym.newVM();
    // Capture a Zym function by returning it from a helper that the JS side
    // then calls via `vm.call`. The returned value must decode into a real
    // callable (Pass 2 behavior).
    vm.run(`
        func square(x) { return x * x; }
        func getSquare() { return square; }
        var SQ = getSquare();
    `);
    // SQ is now a global holding the square function; retrieve it with a
    // thin identity wrapper.
    vm.run(`func fetchSQ() { return SQ; }`);
    const sq = vm.call("fetchSQ");
    assert(typeof sq === "function", "getSquare() should decode to a JS function");
    assert(sq.__zymCallable === true, "callable marker should be set");
    assert(sq(7) === 49, `sq(7) expected 49, got ${sq(7)}`);
    assert(sq(-3) === 9, `sq(-3) expected 9, got ${sq(-3)}`);
    typeof sq.free === "function" && sq.free();
    vm.free();
}

// --- 2. Closure capturing script state ---------------------------------------
{
    const vm = await Zym.newVM();
    vm.run(`func makeAdder(n) { return func(x) { return x + n; }; }`);
    const add10 = vm.call("makeAdder", 10);
    const add100 = vm.call("makeAdder", 100);
    assert(typeof add10 === "function", "makeAdder should decode to a JS callable");
    assert(add10(5) === 15, `add10(5) expected 15, got ${add10(5)}`);
    assert(add100(5) === 105, `add100(5) expected 105, got ${add100(5)}`);
    assert(add10(1) === 11, "closures must retain their captured env across calls");
    vm.free();
}

// --- 3. Callable passed to a JS native, invoked from JS side -----------------
{
    const vm = await Zym.newVM();
    let captured = null;
    vm.registerNative("keep(fn)", (fn) => {
        captured = fn.toJS();
        return null;
    });
    vm.run(`keep(func(a, b) { return a + b; });`);
    assert(typeof captured === "function", "native should receive a callable via toJS()");
    assert(captured(2, 3) === 5, `captured(2,3) expected 5, got ${captured(2, 3)}`);
    captured.free();
    vm.free();
}

// --- 4. vm.callValue accepts a ZymValue wrapper directly ---------------------
{
    const vm = await Zym.newVM();
    vm.registerNative("give(fn)", (fn) => {
        // `fn` is still a ZymValue wrapper here (isCallable()).
        assert(fn.isCallable(), "native arg should be callable");
        const r = vm.callValue(fn, [4, 6]);
        assert(r === 10, `callValue expected 10, got ${r}`);
        return r;
    });
    vm.run(`var result = give(func(a, b) { return a + b; });`);
    vm.free();
}

// --- 5. Callable after vm.free() throws a clear error ------------------------
{
    const vm = await Zym.newVM();
    vm.run(`
        func id(x) { return x; }
        func getId() { return id; }
    `);
    const id = vm.call("getId");
    assert(typeof id === "function", "expected callable");
    vm.free();
    let threw = null;
    try { id(1); } catch (e) { threw = e; }
    assert(threw instanceof ZymError, "invoking callable after vm.free() should throw ZymError");
}

// --- 6. Forgotten .free() does not crash; GC eventually reclaims -------------
{
    const vm = await Zym.newVM();
    vm.run(`func mk(n) { return func(x) { return x + n; }; }`);
    for (let i = 0; i < 500; i++) {
        const f = vm.call("mk", i);
        assert(f(1) === i + 1, `quick fn #${i} mismatch`);
        // deliberately drop without free
    }
    vm.free();
}

console.log("=== all pass-2 assertions passed ===");
