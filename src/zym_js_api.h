#pragma once

/*
 * zym_js_api.h -- thin C shim that adapts the zym_core public API for use from
 * JavaScript via Emscripten. Everything exposed here is designed to be called
 * through `Module.ccall` / `Module.cwrap` with plain numeric/string parameters;
 * `ZymValue`s never cross the wasm boundary directly. Instead, every value is
 * registered in a per-VM handle table (anchored via an internal Zym map so the
 * Zym GC keeps it alive) and referenced by a simple `uint32_t` id.
 *
 * The JS side is expected to implement two globally-visible `Module` members:
 *   Module.__zjs_onError(vmPtr, type, file, line, message)
 *   Module.__zjs_nativeDispatch(cbId, vmPtr, arity, argHandlesPtr,
 *                               isVariadic, outIsErrorPtr) -> resultHandle
 *
 * See `js/zym.mjs` for the JS-side glue that wires those up.
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "zym/zym.h"

#ifdef __cplusplus
extern "C" {
#endif

// -----------------------------------------------------------------------------
// Status codes returned to JS. Mirrors `ZymStatus` plus bridge-specific values.
// Kept as plain ints because JS is easier when it doesn't have to know the
// enum's layout.
// -----------------------------------------------------------------------------
#define ZJS_OK             0
#define ZJS_COMPILE_ERROR  1
#define ZJS_RUNTIME_ERROR  2
#define ZJS_YIELD          3
#define ZJS_BRIDGE_ERROR   100  // bad handle, bad arity, allocation failure, etc.

// -----------------------------------------------------------------------------
// Value-kind tags returned by `zjs_valueKind`. Stable numeric ids so JS code
// can switch on them without importing an enum.
// -----------------------------------------------------------------------------
#define ZJS_KIND_NULL          0
#define ZJS_KIND_BOOL          1
#define ZJS_KIND_NUMBER        2
#define ZJS_KIND_STRING        3
#define ZJS_KIND_LIST          4
#define ZJS_KIND_MAP           5
#define ZJS_KIND_STRUCT        6
#define ZJS_KIND_ENUM          7
#define ZJS_KIND_FUNCTION      8
#define ZJS_KIND_CLOSURE       9
#define ZJS_KIND_PROMPT_TAG   10
#define ZJS_KIND_CONTINUATION 11
#define ZJS_KIND_UNKNOWN     255

// -----------------------------------------------------------------------------
// VM lifecycle
// -----------------------------------------------------------------------------
// Create a new VM. Returns a wasm pointer that JS treats as an opaque vm id.
ZymVM* zjs_newVM(void);
// Destroy the VM and everything it owns (handles, chunks, closures, natives).
void   zjs_freeVM(ZymVM* vm);

// -----------------------------------------------------------------------------
// Handle table
// -----------------------------------------------------------------------------
// Release a handle previously returned by this API. Safe to call with id 0.
void     zjs_releaseHandle(ZymVM* vm, uint32_t handle);
// Retrieve the kind of a handle. Returns ZJS_KIND_UNKNOWN on invalid handle.
uint32_t zjs_valueKind(ZymVM* vm, uint32_t handle);

// Primitive constructors.
uint32_t zjs_newNull(ZymVM* vm);
uint32_t zjs_newBool(ZymVM* vm, int value);
uint32_t zjs_newNumber(ZymVM* vm, double value);
// `str` is UTF-8; `len` is byte length. Copies into VM-owned memory.
uint32_t zjs_newString(ZymVM* vm, const char* str, int len);
uint32_t zjs_newList(ZymVM* vm);
uint32_t zjs_newMap(ZymVM* vm);

// Primitive accessors (caller must have type-checked via zjs_valueKind first).
int      zjs_asBool(ZymVM* vm, uint32_t handle);
double   zjs_asNumber(ZymVM* vm, uint32_t handle);
// Returns a pointer to VM-owned UTF-8 bytes; writes byte length into *out_len.
// The pointer is valid until the next GC; callers should copy it to JS
// immediately (which `UTF8ToString`/`HEAPU8.subarray` do naturally).
const char* zjs_asString(ZymVM* vm, uint32_t handle, int* out_len);

// Produce a Zym-formatted display string for *any* value kind (mirrors the
// output of `zym_printValue`). Returns a new handle referencing a Zym string,
// or 0 on failure. Callers must release the returned handle normally.
uint32_t zjs_valueToString(ZymVM* vm, uint32_t handle);

// List ops.
int      zjs_listLength(ZymVM* vm, uint32_t list);
uint32_t zjs_listGet(ZymVM* vm, uint32_t list, int index);
int      zjs_listSet(ZymVM* vm, uint32_t list, int index, uint32_t value);
int      zjs_listAppend(ZymVM* vm, uint32_t list, uint32_t value);

// Map ops. Keys are always strings.
int      zjs_mapSize(ZymVM* vm, uint32_t map);
int      zjs_mapHas(ZymVM* vm, uint32_t map, const char* key);
uint32_t zjs_mapGet(ZymVM* vm, uint32_t map, const char* key);
int      zjs_mapSet(ZymVM* vm, uint32_t map, const char* key, uint32_t value);
int      zjs_mapDelete(ZymVM* vm, uint32_t map, const char* key);
// Snapshot the map's keys into a fresh Zym list of strings. Returns a new
// handle that the caller must release. The returned list is independent of
// the map, so iterating it while mutating the map is safe.
uint32_t zjs_mapKeys(ZymVM* vm, uint32_t map);

// Struct introspection. The `const char*` returns point into VM-owned
// memory (the struct's type table) and stay valid until the next GC, just
// like `zjs_asString`; callers should copy to JS immediately via
// `UTF8ToString`. `zjs_structGetField` returns a fresh handle to release.
const char* zjs_structName(ZymVM* vm, uint32_t handle);
int         zjs_structFieldCount(ZymVM* vm, uint32_t handle);
const char* zjs_structFieldNameAt(ZymVM* vm, uint32_t handle, int index);
uint32_t    zjs_structGetField(ZymVM* vm, uint32_t handle, const char* name);

// Enum introspection. Same memory-ownership rules as the struct accessors.
const char* zjs_enumTypeName(ZymVM* vm, uint32_t handle);
const char* zjs_enumVariantName(ZymVM* vm, uint32_t handle);
int         zjs_enumVariantIndex(ZymVM* vm, uint32_t handle);

// -----------------------------------------------------------------------------
// Compilation and execution
// -----------------------------------------------------------------------------
// Compile `source` (UTF-8). `entry_file` may be NULL. Allocates a chunk that
// must be freed with `zjs_freeChunk`. Writes an opaque chunk pointer into
// `*out_chunk` on success.
int zjs_compile(ZymVM* vm, const char* source, const char* entry_file,
                int include_line_info, ZymChunk** out_chunk);

// Run a previously compiled chunk. Returns ZJS_OK / ZJS_COMPILE_ERROR /
// ZJS_RUNTIME_ERROR / ZJS_YIELD.
int zjs_runChunk(ZymVM* vm, ZymChunk* chunk);

void zjs_freeChunk(ZymVM* vm, ZymChunk* chunk);

// Serialize a chunk to bytecode. On success, `*out_buf` points to malloc'd
// memory owned by the caller (free via `zjs_freeBytecode`) and `*out_size`
// is the byte length.
int  zjs_serializeChunk(ZymVM* vm, ZymChunk* chunk, int include_line_info,
                        char** out_buf, size_t* out_size);
void zjs_freeBytecode(char* buf);
// Deserialize bytecode into an existing (newly allocated) chunk.
int  zjs_deserializeChunk(ZymVM* vm, ZymChunk* chunk,
                          const char* buf, size_t size);

// -----------------------------------------------------------------------------
// Globals and native registration
// -----------------------------------------------------------------------------
int zjs_defineGlobal(ZymVM* vm, const char* name, uint32_t value_handle);

// Register a JS function as a Zym native. `signature` follows the zym_core
// convention, e.g. `"greet(name)"` or `"log(level, ...)"`. `cb_id` is an
// opaque integer the JS side uses to look up the actual JS function.
// Returns ZJS_OK on success.
int zjs_registerNative(ZymVM* vm, const char* signature, uint32_t cb_id);
int zjs_registerNativeVariadic(ZymVM* vm, const char* signature, uint32_t cb_id);

// -----------------------------------------------------------------------------
// Calling script functions from JS
// -----------------------------------------------------------------------------
// Calls `func_name` with `argc` handles from the `argv_handles` array.
// On success (ZJS_OK), `*out_result` receives a new handle for the result
// (or 0 if the result is null). On failure, `*out_result` is 0.
int zjs_callFunction(ZymVM* vm, const char* func_name,
                     int argc, const uint32_t* argv_handles,
                     uint32_t* out_result);

// -----------------------------------------------------------------------------
// Build info
// -----------------------------------------------------------------------------
const char* zjs_version(void);

#ifdef __cplusplus
}
#endif
