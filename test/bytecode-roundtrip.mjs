/*
 * bytecode-roundtrip.mjs -- verifies serialize/loadBytecode across the wasm
 * bridge. Run with:  node test/bytecode-roundtrip.mjs
 *
 * The serialized format gained a centralized string pool in core v0.3.0, and
 * function records changed shape. Nothing in the existing suite exercised
 * serialize -> loadBytecode, so a format regression would have shipped
 * silently. This covers every serialized constant kind (strings, numbers,
 * null/bool, nested functions with upvalues, struct and enum schemas, enum
 * values), both with and without line info, and asserts the loaded program
 * produces byte-identical output to the original.
 *
 * Exits non-zero if any assertion fails.
 */

import assert from "node:assert/strict";
import Zym from "../js/zym.mjs";

// Exercises every constant kind the serializer knows how to write. The
// repeated identifiers matter: the string pool is supposed to store each
// one once no matter how many nested chunks reference it.
const SOURCE = `
enum Grade { A, B, C }
struct Rec { id; label }

var sharedCounterValue = 0

func bumpSharedCounterValue(n) {
    sharedCounterValue = sharedCounterValue + n
    return sharedCounterValue
}

func makeAccumulator(base) {
    func step(x) { base = base + x; return base }
    return step
}

func describe(g) {
    if (g == Grade.B) { return "bee" }
    return "other"
}

func main() {
    var r = Rec { .id = 7, .label = "seven" }
    var acc = makeAccumulator(10)
    var total = acc(1) + acc(2) + bumpSharedCounterValue(3) + r.id
    return str("%n|%s|%s", total, r.label, describe(Grade.B))
}
`;

let failures = 0;
function check(cond, label) {
    if (cond) {
        console.log(`[PASS] ${label}`);
    } else {
        console.log(`[FAIL] ${label}`);
        failures++;
    }
}

// Run a chunk in a fresh VM, then call `main()` and return its result.
async function runAndCapture(loadInto) {
    const vm = await Zym.newVM();
    const chunk = loadInto(vm);
    chunk.run();
    return { vm, out: vm.call("main") };
}

console.log("loaded:", await Zym.version());

// --- baseline: compile + run directly -------------------------------------
const producer = await Zym.newVM();
const original = producer.compile(SOURCE, { includeLineInfo: true });

const direct = await runAndCapture((vm) => vm.compile(SOURCE, { includeLineInfo: true }));
check(typeof direct.out === "string" && direct.out.length > 0,
      `baseline produces a result (${direct.out})`);

// --- with line info -------------------------------------------------------
const withLines = producer.serialize(original, { includeLineInfo: true });
check(withLines instanceof Uint8Array && withLines.length > 0,
      `serialize with line info yields bytes (${withLines.length})`);
check(String.fromCharCode(...withLines.slice(0, 3)) === "ZYM",
      "serialized output carries the ZYM magic");

const loaded = await runAndCapture((vm) => vm.loadBytecode(withLines));
check(loaded.out === direct.out,
      `loaded bytecode produces identical output (${loaded.out})`);

// --- without line info (smaller, and the path --strip uses) ---------------
const noLines = producer.serialize(original, { includeLineInfo: false });
check(noLines.length > 0, `serialize without line info yields bytes (${noLines.length})`);
check(noLines.length < withLines.length,
      `stripped output is smaller (${noLines.length} < ${withLines.length})`);

const loadedStripped = await runAndCapture((vm) => vm.loadBytecode(noLines));
check(loadedStripped.out === direct.out,
      "stripped bytecode produces identical output");

// --- determinism: same chunk serialized twice must be byte-identical ------
const again = producer.serialize(original, { includeLineInfo: true });
check(again.length === withLines.length &&
      again.every((b, i) => b === withLines[i]),
      "serializing the same chunk twice is byte-identical");

// --- string pool: repeated identifiers stored once ------------------------
// `sharedCounterValue` is referenced from three chunks (define, read, write).
// Pre-pool it appeared once per referencing chunk.
const asText = Buffer.from(withLines).toString("latin1");
const occurrences = asText.split("sharedCounterValue").length - 1;
check(occurrences === 1,
      `repeated identifier stored once in the pool (found ${occurrences})`);

// --- malformed input is rejected, not fatal -------------------------------
const corrupt = Uint8Array.from(withLines);
corrupt[7] ^= 0xff;               // damage a header/pool field
let rejected = false;
try {
    const vm = await Zym.newVM();
    vm.loadBytecode(corrupt);
} catch {
    rejected = true;
}
check(rejected, "corrupt bytecode is rejected without killing the host");

const truncated = withLines.slice(0, Math.floor(withLines.length / 2));
let truncRejected = false;
try {
    const vm = await Zym.newVM();
    vm.loadBytecode(truncated);
} catch {
    truncRejected = true;
}
check(truncRejected, "truncated bytecode is rejected without killing the host");

console.log(`\n=== ${failures === 0 ? "all bytecode round-trip assertions passed"
                                    : `${failures} FAILURES`} ===`);
process.exit(failures === 0 ? 0 : 1);
