// Every code example in doc.md's Sandboxing section, run for real so the
// documented output is observed rather than written from memory.
import { Zym, STATE, CAUSE, ZymSuspended } from "../js/zym.mjs";

// ---- 1. stopping runaway code ---------------------------------------------
console.log("--- 1 ---");
{
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
    vm.free();
}

// ---- 2. an event pump into the script -------------------------------------
console.log("--- 2 ---");
{
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
    vm.free();
}

// ---- 3. capping memory ----------------------------------------------------
console.log("--- 3 ---");
{
    const vm = await Zym.newVM();
    vm.setMemoryLimit(vm.memoryUsed() + 1024 * 1024);   // +1 MiB

    try {
        vm.run(`var hoard = []
var i = 0
while (true) { push(hoard, [i, i])
 i = i + 1 }`);
    } catch (e) {
        if (e.cause === CAUSE.MEMORY_LIMIT) {
            console.log("hit the ceiling wanting", e.bytesWanted, "more bytes");
        } else throw e;
    }
    vm.free();
}

// ---- 4. a progress meter that can also give up ----------------------------
console.log("--- 4 ---");
{
    const vm = await Zym.newVM();
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
    vm.free();
}

// ---- 5. inspecting a stopped VM -------------------------------------------
console.log("--- 5 ---");
{
    const vm = await Zym.newVM();
    vm.addPreempt(500_000);
    try { vm.run("var i = 0\nwhile (true) { i = i + 1 }"); } catch {}

    const i = vm.info();
    console.log("state SUSPENDED:", i.state === STATE.SUSPENDED,
                " cause PREEMPT:", i.cause === CAUSE.PREEMPT,
                " resumable:", i.resumable);
    vm.free();
}

// ---- 6. budgeting the entry table -----------------------------------------
console.log("--- 6 ---");
{
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
    vm.free();
}

// ---- 7. bounds and host calls ---------------------------------------------
console.log("--- 7 ---");
{
    const DEF = `func work() { var i = 0
 while (i < 5000000) { i = i + 1 }
 return i }`;

    // Work that run() is executing can be paused.
    const a = await Zym.newVM();
    a.addPreempt(200_000);
    try { a.run(DEF + "\nwork()"); } catch (e) {
        console.log("run():  suspended:", e instanceof ZymSuspended,
                    " resumable:", a.info().resumable);
    }
    a.free();

    // The same work reached through a host call cannot be paused.
    const b = await Zym.newVM();
    b.run(DEF);
    b.addPreempt(200_000);
    try { b.call("work"); } catch (e) {
        console.log("call(): suspended:", e instanceof ZymSuspended,
                    " resumable:", b.info().resumable);
    }
    b.free();
}
