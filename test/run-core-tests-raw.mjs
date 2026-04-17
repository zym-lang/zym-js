/*
 * run-core-tests-raw.mjs -- runs every .zym file in core_tests/ through the
 * wasm bridge and prints each test's raw output verbatim. No pass/fail
 * summary, no per-test tags -- just whatever the script itself prints.
 * Uses the same print() semantics as run-core-tests.mjs (matching
 * zym_core/src/natives/print.c).
 */

import Zym from "../js/zym.mjs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = join(__dirname, "..", "core_tests");

// ---------------------------------------------------------------------------
// print() implementation matching zym_core/src/natives/print.c semantics.
// ---------------------------------------------------------------------------
function formatValue(format, argVal) {
    const kind = argVal.kind;
    switch (format) {
        case "s":
            if (kind !== 3) throw new Error(`print() %s expects string, got ${kind}`);
            return argVal.toJS();
        case "n": {
            if (kind !== 2) throw new Error(`print() %n expects number, got ${kind}`);
            const js = argVal.toJS();
            if (Number.isFinite(js) && Math.trunc(js) === js && js >= -1e15 && js <= 1e15) {
                return js.toFixed(0);
            }
            return Number(js.toPrecision(6)).toString();
        }
        case "b":
            if (kind !== 1) throw new Error(`print() %b expects bool, got ${kind}`);
            return argVal.toJS() ? "true" : "false";
        case "l":
            if (kind !== 4) throw new Error(`print() %l expects list, got ${kind}`);
            return argVal.display();
        case "m":
            if (kind !== 5) throw new Error(`print() %m expects map, got ${kind}`);
            return argVal.display();
        case "t":
            if (kind !== 6) throw new Error(`print() %t expects struct, got ${kind}`);
            return argVal.display();
        case "e":
            if (kind !== 7) throw new Error(`print() %e expects enum, got ${kind}`);
            return argVal.display();
        case "v":
            return argVal.display();
        default:
            throw new Error(`print() unknown format specifier '%${format}'`);
    }
}

function composePrint(args) {
    if (args.length === 0) return "";
    if (args.length === 1) {
        const only = args[0];
        const kind = only.kind;
        const js = only.toJS();
        if (kind === 3) {
            let hasFormat = false;
            for (let i = 0; i < js.length - 1; i++) {
                if (js[i] === "%" && js[i + 1] !== "%") { hasFormat = true; break; }
            }
            if (hasFormat) return renderFormat(js, []);
        }
        if (kind === 3) return js;
        if (kind === 2) {
            if (Number.isFinite(js) && Math.trunc(js) === js && js >= -1e15 && js <= 1e15) {
                return js.toFixed(0);
            }
            return Number(js.toPrecision(6)).toString();
        }
        if (kind === 1) return js ? "true" : "false";
        if (kind === 0) return "null";
        return only.display();
    }
    const fmt = args[0];
    if (fmt.kind !== 3) throw new Error("print() first argument must be a string");
    return renderFormat(fmt.toJS(), args.slice(1));
}

function renderFormat(fmt, args) {
    let out = "";
    let argIdx = 0;
    for (let i = 0; i < fmt.length; i++) {
        const c = fmt[i];
        if (c !== "%") { out += c; continue; }
        i++;
        if (i >= fmt.length) throw new Error("print() format string ends with incomplete format specifier");
        const spec = fmt[i];
        if (spec === "%") { out += "%"; continue; }
        if (argIdx >= args.length) throw new Error("print() format string requires more arguments than provided");
        out += formatValue(spec, args[argIdx]);
        argIdx++;
    }
    if (argIdx < args.length) {
        throw new Error(`print() provided ${args.length} arguments but format string only uses ${argIdx}`);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Run a single test: stream print() output straight to stdout.
// ---------------------------------------------------------------------------
async function runOne(file) {
    const source = await readFile(file, "utf8");
    const vm = await Zym.newVM();

    vm.registerNative("print(...)", (...args) => {
        let line;
        try { line = composePrint(args); }
        catch (e) { line = `[print error] ${e.message}`; }
        process.stdout.write(line + "\n");
        return null;
    });

    try {
        vm.run(source, { file });
    } catch (e) {
        process.stdout.write(`[error] ${e.message}\n`);
    }

    vm.free();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const files = (await readdir(TESTS_DIR)).filter((f) => f.endsWith(".zym")).sort();

for (const f of files) {
    await runOne(join(TESTS_DIR, f));
}
