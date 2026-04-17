/*
 * node-smoke.mjs -- end-to-end smoke test for the JS bridge.
 * Run with:  node test/node-smoke.mjs
 *
 * Exits non-zero if any assertion fails.
 */

import assert from "node:assert/strict";
import Zym, { ZymError } from "../js/zym.mjs";

function section(label) {
    console.log(`\n--- ${label} ---`);
}

console.log("loaded:", await Zym.version());

const vm = await Zym.newVM();
const errors = [];
vm.on("error", (e) => errors.push(e));

try {
    // ----- 1. compile + run a basic script -----
    section("basic run");
    vm.run(`var x = 2 + 3;`);
    console.log("ran: var x = 2 + 3;");

    // ----- 2. define a global + read it back via a script function -----
    section("globals + script fn");
    vm.defineGlobal("PI", Math.PI);
    vm.run(`
        func area(r) {
            return PI * r * r;
        }
    `);
    const a = vm.call("area", 2);
    console.log("area(2) =", a);
    assert.ok(Math.abs(a - Math.PI * 4) < 1e-9, "area(2) should be ~4*PI");

    // ----- 3. JS native callable from Zym -----
    section("JS native");
    let greetCalled = 0;
    vm.registerNative("greet(name)", (name) => {
        greetCalled++;
        return `hello, ${name.toJS()}!`;
    });
    vm.run(`
        func makeGreeting() {
            return greet("world");
        }
    `);
    const g = vm.call("makeGreeting");
    console.log("greet result:", g);
    assert.equal(g, "hello, world!");
    assert.equal(greetCalled, 1);

    // ----- 4. variadic JS native -----
    section("variadic native");
    vm.registerNative("sum(...)", (...nums) => {
        let total = 0;
        for (const n of nums) total += n.toJS();
        return total;
    });
    vm.run(`
        func addAll() {
            return sum(1, 2, 3, 4, 5);
        }
    `);
    const s = vm.call("addAll");
    console.log("sum(1..5) =", s);
    assert.equal(s, 15);

    // ----- 5. compile errors surface as ZymError -----
    section("compile error handling");
    let threw = false;
    try {
        vm.run(`var = 1;`);
    } catch (e) {
        threw = true;
        assert.ok(e instanceof ZymError, "expected ZymError");
        console.log("got expected compile error:", e.message.split("\n")[0]);
    }
    assert.ok(threw, "compile of bad source should have thrown");

    // ----- 6. list marshalling round-trip -----
    section("list round-trip");
    vm.registerNative("echoList(xs)", (xs) => xs.toJS());
    vm.run(`
        func passThrough() {
            return echoList([10, 20, 30]);
        }
    `);
    const list = vm.call("passThrough");
    assert.deepEqual(list, [10, 20, 30]);
    console.log("list =", list);

    console.log(`\n=== all smoke assertions passed; ${errors.length} error events captured ===`);
} finally {
    vm.free();
}
