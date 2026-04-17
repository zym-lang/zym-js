/*
 * run-core-tests.mjs -- runs every .zym file in core_tests/ through the
 * wasm bridge and reports which succeed. Tests use a `print` native with
 * printf-like format specifiers; we implement the same semantics as
 * zym_core's sample print.c in JS (the bridge deliberately does not wire
 * a default print so users always control stdout).
 */

import Zym, { ZymValue } from "../js/zym.mjs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = join(__dirname, "..", "core_tests");

// ---------------------------------------------------------------------------
// print() implementation matching zym_core/src/natives/print.c semantics.
// Returns the composed line; the caller decides whether to println/buffer.
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
            // Emulate C's %g: up to 6 significant digits, trim trailing zeros.
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
            // Universal display: delegate to the VM's formatter for every kind.
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
        // If the single arg is a string containing an unescaped `%x`, treat
        // it as a format string (matches print.c single-arg behavior).
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
        // Everything else (enum, struct, list, map, closure, ...) goes through
        // the VM's own display formatter so output matches zym_printValue
        // exactly -- and so we never JSON.stringify a ZymValue wrapper (which
        // would traverse the Emscripten Module via the back-pointer and hang).
        return only.display();
    }
    // 2+ args: first must be a format string.
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
// Run a single test file.
// ---------------------------------------------------------------------------
async function runOne(file) {
    const source = await readFile(file, "utf8");
    const vm = await Zym.newVM();
    // Stream-scan: keep FAILED lines and a byte-capped tail for debugging.
    const MAX_TAIL_BYTES = 32 * 1024;
    let tail = "";
    const failedLines = [];
    let totalLines = 0;
    const errors = [];
    vm.on("error", (e) => errors.push(e));

    vm.registerNative("print(...)", (...args) => {
        let line;
        try { line = composePrint(args); }
        catch (e) {
            failedLines.push(`[print error] ${e.message}`);
            throw e;
        }
        totalLines++;
        if (/\bFAILED\b/.test(line)) failedLines.push(line);
        // Byte-cap the tail by trimming from the left when oversized.
        tail += line + "\n";
        if (tail.length > MAX_TAIL_BYTES * 2) tail = tail.slice(-MAX_TAIL_BYTES);
        return null;
    });

    let status = "pass";
    let detail = "";
    try {
        vm.run(source, { file });
    } catch (e) {
        status = "error";
        detail = e.message.split("\n")[0];
    }

    if (status === "pass" && failedLines.length > 0) {
        status = "fail";
        detail = failedLines[0].trim().slice(0, 120);
    }

    vm.free();
    return { status, detail, tail, totalLines, errors, failedLines };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const files = (await readdir(TESTS_DIR)).filter((f) => f.endsWith(".zym")).sort();
let pass = 0, fail = 0, error = 0;
const results = [];

for (const f of files) {
    const path = join(TESTS_DIR, f);
    const r = await runOne(path);
    results.push({ file: f, ...r });
    if (r.status === "pass")  pass++;
    else if (r.status === "fail")  fail++;
    else error++;
    const tag = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "ERR ";
    console.log(`[${tag}] ${f}${r.detail ? "  :: " + r.detail : ""}`);
}

console.log(`\n=== ${pass} pass, ${fail} fail, ${error} error, out of ${files.length} ===`);

if (process.argv.includes("--verbose")) {
    for (const r of results) {
        if (r.status !== "pass") {
            console.log(`\n--- ${r.file} (${r.status}) ---`);
            console.log(r.tail);
            if (r.errors.length) console.log("errors:", r.errors);
        }
    }
}

process.exit(fail + error > 0 ? 1 : 0);
