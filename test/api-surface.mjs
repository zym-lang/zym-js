import Zym from "../js/zym.mjs";
let fails = 0;
const check = (c, l) => { console.log(`${c ? "[PASS]" : "[FAIL]"} ${l}`); if (!c) fails++; };

const vm = await Zym.newVM();
vm.on("error", () => {});   // swallow; we assert via diagnostics()

// --- diagnostics -----------------------------------------------------------
try { vm.compile(`var x = ;`); } catch {}
const diags = vm.diagnostics();
check(diags.length > 0, `diagnostics() returns records (${diags.length})`);
if (diags.length) {
  const d = diags[0];
  check(typeof d.message === "string" && d.message.length > 0, `record has message ("${d.message.trim()}")`);
  check(d.severity === "error", `severity mapped to string ("${d.severity}")`);
  check(Number.isInteger(d.line), `line is numeric (${d.line})`);
  check("startByte" in d && "column" in d, "byte/column span present");
}
vm.clearDiagnostics();
check(vm.diagnostics().length === 0, "clearDiagnostics() empties the buffer");

// --- probing ---------------------------------------------------------------
const vm2 = await Zym.newVM();
vm2.run(`func greet(a) { return a }`);
check(vm2.hasFunction("greet", 1), "hasFunction finds a defined function");
check(!vm2.hasFunction("nope", 0), "hasFunction rejects an unknown name");

// --- disassembly -----------------------------------------------------------
const chunk = vm2.compile(`func f(a){ return a + 1 }`);
const text = vm2.disassemble(chunk, "demo");
check(text.includes("== demo =="), "disassemble() emits a listing with the given name");
check(/RET|LOAD_CONST|DEFINE_GLOBAL/.test(text), "listing contains opcodes");

// --- cancellation ----------------------------------------------------------
check(vm2.wasCancelled() === false, "wasCancelled() false before any request");
vm2.requestCancel();
let cancelledCompile = false;
try { vm2.compile(`var y = 1`); } catch { cancelledCompile = true; }
check(vm2.wasCancelled() === true, "wasCancelled() true after requestCancel()");
check(cancelledCompile, "a cancelled compile reports failure rather than succeeding");
vm2.clearCancel();
check(vm2.wasCancelled() === false, "clearCancel() resets the flag");
vm2.run(`var z = 5`);
check(true, "VM is reusable after clearCancel()");

console.log(`\n=== ${fails === 0 ? "all new-API assertions passed" : fails + " FAILURES"} ===`);
process.exit(fails ? 1 : 0);
