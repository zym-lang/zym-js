// The sandbox surface: parity with what the CLI's `Zym` native gives a parent
// script. A host must be able to bound untrusted code in time and memory, tell
// apart why it stopped, and take control back on demand.

import { createZym, STATUS, STATE, CAUSE, ZymSuspended, ZymError } from "../js/zym.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
    if (cond) { passed++; console.log(`[PASS] ${label}`); }
    else      { failed++; console.log(`[FAIL] ${label}`); }
}

const Zym = await createZym();

const SPIN    = "var i = 0\nwhile (true) { i = i + 1 }";
const GLUTTON = "var h = []\nvar i = 0\nwhile (true) { push(h, [i, i])\n i = i + 1 }";
const TRIVIAL = "var x = 1 + 1";

// --- a watchdog bounds how long it runs -----------------------------------
{
    const vm = Zym.newVM();
    const id = vm.setWatchdog(200000);
    ok(id !== 0, "setWatchdog returns an id");

    let caught = null;
    try { vm.run(SPIN); } catch (e) { caught = e; }

    ok(caught instanceof ZymSuspended, "an infinite loop suspends rather than hangs");
    ok(caught.cause === CAUSE.PREEMPT, "cause is PREEMPT");
    ok(caught.preemptId === id, "the entry that fired is named");
    ok(caught.resumable, "a watchdog leaves it resumable");
    ok(vm.info().state === STATE.SUSPENDED, "state reads SUSPENDED");

    ok(vm.clearWatchdog(id), "clearWatchdog removes it");
    ok(!vm.clearWatchdog(id), "and is false the second time");
    vm.free();
}

// --- a memory ceiling bounds how much it allocates -------------------------
{
    const vm = Zym.newVM();
    ok(vm.memoryLimit() === 0, "unlimited by default");
    vm.setMemoryLimit(vm.memoryUsed() + 256 * 1024);
    ok(vm.memoryLimit() > 0, "limit reads back");

    let caught = null;
    try { vm.run(GLUTTON); } catch (e) { caught = e; }

    ok(caught instanceof ZymSuspended, "unbounded allocation suspends");
    ok(caught.cause === CAUSE.MEMORY_LIMIT, "cause is MEMORY_LIMIT, not PREEMPT");
    ok(caught.bytesWanted > 0, "the request that crossed the line is reported");
    ok(vm.oomPending(), "the pending condition is visible");
    ok(!caught.resumable, "and it is sticky, so not resumable");

    // Granting room retires it without a separate clear.
    vm.setMemoryLimit(vm.memoryUsed() + 256 * 1024);
    ok(vm.info().resumable, "granting room makes it resumable");
    vm.free();
}

// --- a hard stop ----------------------------------------------------------
{
    const vm = Zym.newVM();
    vm.requestStop();
    ok(vm.stopRequested(), "stopRequested reflects it");

    let caught = null;
    try { vm.run(SPIN); } catch (e) { caught = e; }
    ok(caught instanceof ZymSuspended, "a pending stop suspends the run");
    ok(caught.cause === CAUSE.HOST_STOP, "cause is HOST_STOP");
    ok(!caught.resumable, "sticky until cleared");

    vm.clearStop();
    ok(!vm.stopRequested(), "clearStop resets it");
    ok(vm.info().resumable, "and it becomes resumable");
    vm.free();
}

// --- resuming in slices ----------------------------------------------------
{
    const vm = Zym.newVM();
    vm.setWatchdog(50000);

    let slices = 0, done = false;
    try { vm.run("var t = 0\nvar i = 0\nwhile (i < 400000) { t = t + 1\n i = i + 1 }\nfunc get(){ return t }"); done = true; }
    catch (e) { if (!(e instanceof ZymSuspended)) throw e; }

    while (!done && slices < 500) {
        slices++;
        try { vm.resume(); done = true; }
        catch (e) { if (!(e instanceof ZymSuspended)) throw e; }
    }
    ok(done, "repeated resume completes the work");
    ok(slices > 1, `and took more than one slice (${slices})`);
    ok(vm.info().state === STATE.IDLE, "ending IDLE");
    ok(vm.call("get") === 400000, "the work actually finished");
    vm.free();
}

// --- an ordinary program is untouched --------------------------------------
{
    const vm = Zym.newVM();
    vm.setWatchdog(100000000);
    vm.setMemoryLimit(vm.memoryUsed() + 8 * 1024 * 1024);
    let threw = false;
    try { vm.run(TRIVIAL); } catch { threw = true; }
    ok(!threw, "a generous budget leaves a normal program alone");
    ok(vm.info().state === STATE.IDLE, "and it ends IDLE");
    ok(vm.info().cause === CAUSE.NONE, "with no cause");
    vm.free();
}

// --- a failure is a different thing from a suspension ----------------------
{
    const vm = Zym.newVM();
    let caught = null;
    try { vm.run("var bad = null\nbad.nope()"); } catch (e) { caught = e; }
    ok(caught instanceof ZymError, "a failing script throws");
    ok(!(caught instanceof ZymSuspended), "but not as a suspension");
    ok(vm.info().state === STATE.FAILED, "state is FAILED, never SUSPENDED");
    ok(!vm.info().resumable, "and it is not resumable");
    vm.free();
}

// --- the preemption budget -------------------------------------------------
{
    const vm = Zym.newVM();
    const cap = vm.preemptCapacity();
    ok(cap > 0, `preemptCapacity reports the table size (${cap})`);
    ok(vm.preemptReserve() === 0, "no reserve by default");

    vm.setPreemptReserve(2);
    ok(vm.preemptReserve() === 2, "a reserve set before execution sticks");

    vm.run(TRIVIAL);   // the VM has now executed

    let threw = false;
    try { vm.setPreemptReserve(4); } catch { threw = true; }
    ok(threw, "and is refused afterwards, so a script budget cannot shift");

    const id = vm.setWatchdog(1000000);
    ok(vm.preemptUsed() >= 1, "preemptUsed counts live entries");
    vm.clearWatchdog(id);
    vm.free();
}

// --- probing: hasFunc / getFunc -------------------------------------------
{
    const vm = Zym.newVM();
    vm.run(`
func plain(a, b) { return a + b }
func varia(prefix, ...rest) { return prefix + str(length(rest)) }
func none() { return 7 }
`);

    ok(vm.hasFunc("plain"), "hasFunc finds a fixed-arity function");
    ok(vm.hasFunc("varia"), "and a variadic one");
    ok(!vm.hasFunc("nope"), "and is false for an unknown name");

    ok(vm.hasFunc("plain", 2), "hasFunc(name, arity) matches an exact slot");
    ok(!vm.hasFunc("plain", 3), "and rejects a wrong arity");

    // The reason hasFunc exists: hasFunction demands an exact fixed slot, so a
    // variadic that CAN take three arguments does not register there.
    ok(vm.hasFunc("varia", 3), "a variadic dispatches at an arity above its prefix");
    ok(!vm.hasFunction("varia", 3), "which the strict hasFunction probe misses");

    const plain = vm.getFunc("plain");
    ok(typeof plain === "function", "getFunc returns a callable");
    ok(plain(2, 3) === 5, "and calling it works");
    ok(plain.name === "plain", "with the script name attached");

    ok(vm.getFunc("plain") === plain, "getFunc is identity-stable");
    ok(vm.getFunc("nope") === null, "and null for an unknown name");

    const none = vm.getFunc("none");
    ok(none() === 7, "a zero-arg function round-trips");
    vm.free();
}

console.log(`\n=== sandbox: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
