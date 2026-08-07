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
    const id = vm.addPreempt(200000);   // no handler == watchdog
    ok(id !== 0, "addPreempt returns an id");

    let caught = null;
    try { vm.run(SPIN); } catch (e) { caught = e; }

    ok(caught instanceof ZymSuspended, "an infinite loop suspends rather than hangs");
    ok(caught.cause === CAUSE.PREEMPT, "cause is PREEMPT");
    ok(caught.preemptId === id, "the entry that fired is named");
    ok(caught.resumable, "a watchdog leaves it resumable");
    ok(vm.info().state === STATE.SUSPENDED, "state reads SUSPENDED");

    ok(vm.removePreempt(id), "removePreempt removes it");
    ok(!vm.removePreempt(id), "and is false the second time");
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
    vm.addPreempt(50000);

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
    vm.addPreempt(100000000);
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

    const id = vm.addPreempt(1000000);
    ok(vm.preemptUsed() >= 1, "preemptUsed counts live entries");
    vm.removePreempt(id);
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

// --- a handler turns an entry into an event pump ---------------------------
{
    const vm = Zym.newVM();
    let ticks = 0;
    const id = vm.addPreempt(50_000, () => { ticks++; });

    vm.run("var t = 0\nvar i = 0\nwhile (i < 400000) { t = t + 1\n i = i + 1 }\nfunc get(){ return t }");

    ok(ticks > 1, `a handler fires repeatedly and execution continues (${ticks})`);
    ok(vm.call("get") === 400000, "and the script still completes correctly");
    ok(vm.info().state === STATE.IDLE, "ending IDLE, with no suspension surfaced");
    vm.removePreempt(id);
    vm.free();
}

// --- the handler may call into the parked VM -------------------------------
{
    // The event-pump pattern: a script exposes a hook and the host drives it.
    const vm = Zym.newVM();
    let pumped = 0;
    vm.addPreempt(50_000, () => { if (vm.call("onTick") === 1) pumped++; });

    vm.run(`
var beats = 0
func onTick() { beats = beats + 1
 return 1 }
var t = 0
var i = 0
while (i < 400000) { t = t + 1
 i = i + 1 }
func total() { return t }
func beatCount() { return beats }
`);

    ok(pumped > 1, `the handler called into the VM on each tick (${pumped})`);
    ok(vm.call("beatCount") === pumped, "the script saw every tick");
    ok(vm.call("total") === 400000, "and its own state was undisturbed");
    vm.free();
}

// --- returning false stops instead of resuming -----------------------------
{
    const vm = Zym.newVM();
    let ticks = 0;
    vm.addPreempt(50_000, () => { ticks++; return ticks < 3; });

    let caught = null;
    try { vm.run(SPIN); } catch (e) { caught = e; }
    ok(caught instanceof ZymSuspended, "returning false stops the run");
    ok(ticks === 3, `after exactly the expected number of ticks (${ticks})`);
    ok(caught.cause === CAUSE.PREEMPT, "reported as a preemption");
    vm.free();
}

// --- an entry with no handler is still a watchdog --------------------------
{
    const vm = Zym.newVM();
    vm.addPreempt(200_000);            // handler omitted
    let caught = null;
    try { vm.run(SPIN); } catch (e) { caught = e; }
    ok(caught instanceof ZymSuspended, "a handler-less entry suspends, as before");
    ok(caught.cause === CAUSE.PREEMPT, "with cause PREEMPT");
    vm.free();
}

// --- two entries dispatch to their own handlers ----------------------------
{
    const vm = Zym.newVM();
    let fast = 0, slow = 0;
    const a = vm.addPreempt(40_000,  () => { fast++; });
    const b = vm.addPreempt(150_000, () => { slow++; });

    vm.run("var t = 0\nvar i = 0\nwhile (i < 400000) { t = t + 1\n i = i + 1 }");

    ok(fast > 0 && slow > 0, `both entries fired (${fast} fast, ${slow} slow)`);
    ok(fast > slow, "the shorter slice fired more often");
    vm.removePreempt(a); vm.removePreempt(b);
    vm.free();
}

// --- starting a run from inside a handler is refused ------------------------
{
    const vm = Zym.newVM();
    let refused = false;
    vm.addPreempt(50_000, () => {
        try { vm.run("var x = 1"); } catch (e) { refused = true; }
        return false;
    });
    try { vm.run(SPIN); } catch { /* stopped by the handler */ }
    ok(refused, "a nested run() from a handler is refused rather than corrupting");
    vm.free();
}

// --- entry-table introspection ---------------------------------------------
{
    const vm = Zym.newVM();
    const fresh = vm.preempts();
    ok(fresh.capacity === 32, `capacity is the build's table size (${fresh.capacity})`);
    ok(fresh.used === 0 && fresh.entries.length === 0, "a fresh VM holds no entries");
    ok(fresh.used + fresh.free === fresh.capacity, "used + free == capacity");

    vm.setPreemptReserve(4);
    ok(vm.preempts().reserve === 4, "the reserve reads back");
    ok(vm.preempts().scriptCapacity === 28, "scriptCapacity is capacity minus reserve");

    const a = vm.addPreempt(500_000, () => {});
    const b = vm.addPreempt(900_000);
    const s = vm.preempts();
    ok(s.used === 2, "both entries are counted");
    ok(s.hostUsed === 2 && s.scriptUsed === 0, "host-registered entries are not script-owned");

    const ea = s.entries.find(e => e.id === a);
    const eb = s.entries.find(e => e.id === b);
    ok(!!ea && !!eb, "every live id is enumerated");
    ok(ea.remaining === 500_000, `countdown reports the slice (${ea.remaining})`);
    ok(ea.handler === true && eb.handler === false,
       "handler tells a self-resuming entry from a suspending one");

    ok(vm.preemptRemaining(a) === 500_000, "preemptRemaining agrees with the snapshot");
    ok(vm.preemptRemaining(0xdead) === -1, "an unknown id reads -1 rather than throwing");
    ok(vm.triggerPreempt(a) === true, "a live entry can be armed to fire early");
    ok(vm.triggerPreempt(0xdead) === false, "triggering an unknown id is false, not a throw");

    vm.removePreempt(a); vm.removePreempt(b);
    ok(vm.preempts().used === 0, "removing entries frees their slots");
    vm.free();
}

// --- the host's view of script's budget matches what script sees ------------
{
    const vm = Zym.newVM();
    vm.setPreemptReserve(4);
    vm.addPreempt(1_000_000, () => {});

    vm.run(`
func tick() {}
Preempt.every(300000, tick)
Preempt.every(400000, tick)
func avail() { return Preempt.available() }
`);

    const s = vm.preempts();
    ok(s.used === 3, "host and script entries share one table");
    ok(s.hostUsed === 1 && s.scriptUsed === 2, "ownership is split correctly");
    ok(s.scriptAvailable === vm.call("avail"),
       `host and script agree on the remaining script budget (${s.scriptAvailable})`);
    ok(s.entries.filter(e => !e.handler).length === 2,
       "script-owned entries carry no JS handler");
    vm.free();
}

// --- the reserve is what keeps a slot arm-able after script has run ---------
{
    const vm = Zym.newVM();
    vm.setPreemptReserve(2);
    vm.run(`
func tick() {}
var n = 0
while (Preempt.available() > 0) { Preempt.every(1000000 + n, tick)
 n = n + 1 }
func taken() { return Preempt.available() }
`);
    ok(vm.call("taken") === 0, "script exhausted its own budget");
    const s = vm.preempts();
    ok(s.scriptAvailable === 0, "the host sees script's budget is spent");
    ok(s.free >= 2, `the reserve is still free for the host (${s.free})`);
    let armed = true;
    try { vm.addPreempt(50_000); } catch { armed = false; }
    ok(armed, "the host can still arm a watchdog after script filled the table");
    vm.free();
}

// --- setPreemptReserve is refused once the VM has executed ------------------
{
    const vm = Zym.newVM();
    vm.run("var x = 1");
    let refused = false;
    try { vm.setPreemptReserve(4); } catch { refused = true; }
    ok(refused, "the reserve locks once the VM has run, so script's budget is fixed");
    vm.free();
}

// --- once: fire one time and retire ----------------------------------------
const BOUNDED = "var i = 0\nwhile (i < 3000000) { i = i + 1 }";
{
    const vm = Zym.newVM();
    let fired = 0;
    vm.addPreempt(200_000, () => { fired++; }, { once: true });
    vm.run(BOUNDED);
    ok(fired === 1, `a one-shot entry fires exactly once (${fired})`);
    ok(vm.preempts().used === 0, "a one-shot entry retires itself, freeing its slot");
    vm.free();
}
{
    const vm = Zym.newVM();
    let fired = 0;
    vm.addPreempt(200_000, () => { fired++; });
    vm.run(BOUNDED);
    ok(fired > 1, `the default entry rearms and keeps firing (${fired})`);
    ok(vm.preempts().used === 1, "a rearming entry keeps its slot");
    vm.free();
}
// Once it has fired, a one-shot entry no longer bounds anything -- so it is a
// deadline, not a watchdog. Pair it with a rearming entry over unbounded code.
{
    const vm = Zym.newVM();
    let oneshot = 0, guard = 0;
    vm.addPreempt(100_000, () => { oneshot++; }, { once: true });
    vm.addPreempt(400_000, () => { guard++; return guard < 5; });   // the real bound
    try { vm.run(SPIN); } catch { /* stopped by the rearming entry */ }
    ok(oneshot === 1, "the one-shot fired once and then stopped bounding the run");
    ok(guard === 5, "the rearming entry is what actually stopped an endless script");
    vm.free();
}

// --- maskable: a script shield may suppress it ------------------------------
{
    const SHIELDED = `
func work() { var i = 0
 while (i < 2000000) { i = i + 1 } }
Preempt.shield(work)`;

    const hard = Zym.newVM();
    let hardFired = 0;
    hard.addPreempt(100_000, () => { hardFired++; });
    hard.run(SHIELDED);
    ok(hardFired > 0, `an unmaskable entry fires through a script shield (${hardFired})`);
    hard.free();

    const soft = Zym.newVM();
    let softFired = 0;
    soft.addPreempt(100_000, () => { softFired++; }, { maskable: true });
    soft.run(SHIELDED);
    ok(softFired === 0, "a maskable entry is suppressed by a script shield");
    soft.free();
}

// --- a handler held only by the entry table survives collection ------------
// Regression: markRoots marked the legacy on_preempt_callback but never walked
// vm->preempt_table, so an anonymous handler -- referred to by nothing else
// once the registering function returned -- was collected mid-run and the
// entry kept a dangling Value. Under wasm that trapped with "memory access
// out of bounds"; natively the script died silently.
{
    const vm = Zym.newVM();
    let ran = 0;
    vm.registerNative("beat(n)", () => { ran++; return null; });
    let trapped = null;
    try {
        vm.run(`
func setup() { Preempt.every(400000, func() { beat(1) }) }
setup()
var junk = []
var i = 0
while (i < 400000) { junk = [i, i, i]
 i = i + 1 }
`);
    } catch (e) { trapped = e; }
    ok(trapped === null,
       `an anonymous handler survives GC (${trapped ? trapped.message.split("\n")[0] : "no trap"})`);
    ok(ran > 1, `it kept firing across collections (${ran}x)`);
    vm.free();
}

console.log(`\n=== sandbox: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
