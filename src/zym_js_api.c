/*
 * zym_js_api.c -- see zym_js_api.h for the design rationale.
 *
 * Everything here uses only the public `zym/zym.h` API plus Emscripten's
 * EM_JS macro. Handles are anchored via an internal Zym map stored in the
 * VM's global table under a hidden name, so values stay rooted for as long
 * as JS holds a handle id.
 */

#include "zym_js_api.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
/* Host fallback: allow building on non-wasm toolchains for local testing.
 * The EM_JS entry points become harmless stubs and native dispatch / error
 * reporting simply go nowhere when not running under Emscripten. */
#define EM_JS(ret, name, params, body) ret name params { (void)0; return (ret)0; }
#define EM_JS_VOID(name, params, body) void name params { (void)0; }
#endif

/* Hidden global name used to anchor the per-VM handle map. Leading underscore
 * and '@' keep it out of any normal Zym identifier space. */
#define ZJS_HANDLE_MAP_GLOBAL "__zjs_handles@"

/* -------------------------------------------------------------------------- */
/* Per-VM state registry                                                      */
/* -------------------------------------------------------------------------- */

#define ZJS_MAX_VMS 64

typedef struct ZjsVMState {
    ZymVM*   vm;
    ZymValue handles_map;   /* ObjMap anchored via globals. */
    uint32_t next_handle;   /* Monotonic id generator; id 0 is reserved. */
    /* Scratch buffer used by zjs_setDispatchError() to stash a thrown JS
     * native's message so the C trampoline can raise a real Zym runtime
     * error with a useful message. 512 bytes is plenty for one-line errors
     * and we truncate cleanly if a longer message is supplied. */
    char     last_dispatch_error[512];
} ZjsVMState;

static ZjsVMState* g_vms[ZJS_MAX_VMS];

static ZjsVMState* zjs_find_state(ZymVM* vm) {
    for (int i = 0; i < ZJS_MAX_VMS; i++) {
        if (g_vms[i] && g_vms[i]->vm == vm) return g_vms[i];
    }
    return NULL;
}

static int zjs_register_state(ZjsVMState* s) {
    for (int i = 0; i < ZJS_MAX_VMS; i++) {
        if (!g_vms[i]) { g_vms[i] = s; return 1; }
    }
    return 0;
}

static void zjs_unregister_state(ZjsVMState* s) {
    for (int i = 0; i < ZJS_MAX_VMS; i++) {
        if (g_vms[i] == s) { g_vms[i] = NULL; return; }
    }
}

/* -------------------------------------------------------------------------- */
/* Handle table (id <-> ZymValue, anchored via Zym map)                       */
/* -------------------------------------------------------------------------- */

/* Format a handle id as a map key. Using a fixed-width 10-digit key keeps
 * things simple and avoids any hashing surprises. */
static void zjs_key_for(uint32_t id, char out[16]) {
    snprintf(out, 16, "%u", id);
}

static uint32_t zjs_alloc_handle(ZjsVMState* s, ZymValue v) {
    if (zym_isNull(v)) return 0;  /* id 0 always means null -- zero-alloc. */
    uint32_t id = ++s->next_handle;
    if (id == 0) id = ++s->next_handle;  /* Skip 0 on unlikely wrap. */
    char key[16];
    zjs_key_for(id, key);
    if (!zym_mapSet(s->vm, s->handles_map, key, v)) return 0;
    return id;
}

static ZymValue zjs_get_handle(ZjsVMState* s, uint32_t id) {
    if (id == 0) return zym_newNull();
    char key[16];
    zjs_key_for(id, key);
    ZymValue v = zym_mapGet(s->vm, s->handles_map, key);
    if (v == ZYM_ERROR) return zym_newNull();
    return v;
}

static void zjs_release(ZjsVMState* s, uint32_t id) {
    if (id == 0) return;
    char key[16];
    zjs_key_for(id, key);
    zym_mapDelete(s->vm, s->handles_map, key);
}

/* -------------------------------------------------------------------------- */
/* JS entry points (implemented in JS via the Module glue)                    */
/* -------------------------------------------------------------------------- */

EM_JS(uint32_t, zjs_js_dispatch,
      (uint32_t cb_id, uint32_t vm_ptr, int arity, const uint32_t* args_ptr,
       int is_variadic, const uint32_t* vargs_ptr, int vargc,
       int* out_is_error), {
    if (typeof Module.__zjs_nativeDispatch !== "function") {
        HEAP32[out_is_error >> 2] = 1;
        return 0;
    }
    return Module.__zjs_nativeDispatch(
        cb_id, vm_ptr, arity, args_ptr,
        is_variadic, vargs_ptr, vargc, out_is_error);
});

EM_JS(void, zjs_js_on_error,
      (uint32_t vm_ptr, int type, const char* file, int line, const char* msg), {
    if (typeof Module.__zjs_onError === "function") {
        Module.__zjs_onError(
            vm_ptr, type,
            file ? UTF8ToString(file) : "",
            line,
            msg ? UTF8ToString(msg) : "");
    }
});

/* -------------------------------------------------------------------------- */
/* Native closure trampolines                                                 */
/* -------------------------------------------------------------------------- */

/* Shared helper used by every per-arity trampoline. Converts Values to
 * handles, calls into JS, frees the handles, and returns the JS result. */
static ZymValue zjs_dispatch(ZymVM* vm, ZymValue ctx, int arity,
                             const ZymValue* args, int is_variadic,
                             const ZymValue* vargs, int vargc) {
    ZjsVMState* s = zjs_find_state(vm);
    if (!s) return ZYM_ERROR;

    uint32_t cb_id = (uint32_t)(uintptr_t)zym_getNativeData(ctx);

    /* Stack-allocated handle arrays; MAX_NATIVE_ARITY is 10 in zym_core. */
    uint32_t fixed_handles[16];
    for (int i = 0; i < arity; i++) fixed_handles[i] = zjs_alloc_handle(s, args[i]);

    uint32_t* var_handles = NULL;
    if (is_variadic && vargc > 0) {
        var_handles = (uint32_t*)malloc(sizeof(uint32_t) * (size_t)vargc);
        if (!var_handles) {
            for (int i = 0; i < arity; i++) zjs_release(s, fixed_handles[i]);
            zym_runtimeError(vm, "out of memory in native dispatch");
            return ZYM_ERROR;
        }
        for (int i = 0; i < vargc; i++) var_handles[i] = zjs_alloc_handle(s, vargs[i]);
    }

    int is_error = 0;
    uint32_t result_h = zjs_js_dispatch(
        cb_id, (uint32_t)(uintptr_t)vm, arity, fixed_handles,
        is_variadic, var_handles, vargc, &is_error);

    for (int i = 0; i < arity; i++) zjs_release(s, fixed_handles[i]);
    if (var_handles) {
        for (int i = 0; i < vargc; i++) zjs_release(s, var_handles[i]);
        free(var_handles);
    }

    if (is_error) {
        if (result_h) zjs_release(s, result_h);
        /* Raise a real Zym runtime error so the VM aborts and the caller
         * of vm.run / vm.call sees the thrown JS native's message instead
         * of silently continuing with a sentinel value. */
        const char* msg = s->last_dispatch_error[0]
            ? s->last_dispatch_error
            : "JS native threw an unspecified error";
        zym_runtimeError(vm, "%s", msg);
        s->last_dispatch_error[0] = '\0';
        return ZYM_ERROR;
    }

    ZymValue result = zjs_get_handle(s, result_h);
    zjs_release(s, result_h);
    return result;
}

/* Generate the 11 fixed-arity closure trampolines. Each matches the
 * ZymNativeClosureN signature declared in zym_core/src/native.h. */
#define ZJS_ARGV_0  (ZymValue[]){ 0 }, 0
#define ZJS_ARGV_1  ((ZymValue[]){ a0 }), 1
#define ZJS_ARGV_2  ((ZymValue[]){ a0, a1 }), 2
#define ZJS_ARGV_3  ((ZymValue[]){ a0, a1, a2 }), 3
#define ZJS_ARGV_4  ((ZymValue[]){ a0, a1, a2, a3 }), 4
#define ZJS_ARGV_5  ((ZymValue[]){ a0, a1, a2, a3, a4 }), 5
#define ZJS_ARGV_6  ((ZymValue[]){ a0, a1, a2, a3, a4, a5 }), 6
#define ZJS_ARGV_7  ((ZymValue[]){ a0, a1, a2, a3, a4, a5, a6 }), 7
#define ZJS_ARGV_8  ((ZymValue[]){ a0, a1, a2, a3, a4, a5, a6, a7 }), 8
#define ZJS_ARGV_9  ((ZymValue[]){ a0, a1, a2, a3, a4, a5, a6, a7, a8 }), 9
#define ZJS_ARGV_10 ((ZymValue[]){ a0, a1, a2, a3, a4, a5, a6, a7, a8, a9 }), 10

#define ZJS_PARAMS_0
#define ZJS_PARAMS_1  , ZymValue a0
#define ZJS_PARAMS_2  , ZymValue a0, ZymValue a1
#define ZJS_PARAMS_3  , ZymValue a0, ZymValue a1, ZymValue a2
#define ZJS_PARAMS_4  , ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3
#define ZJS_PARAMS_5  , ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4
#define ZJS_PARAMS_6  ZJS_PARAMS_5, ZymValue a5
#define ZJS_PARAMS_7  ZJS_PARAMS_6, ZymValue a6
#define ZJS_PARAMS_8  ZJS_PARAMS_7, ZymValue a7
#define ZJS_PARAMS_9  ZJS_PARAMS_8, ZymValue a8
#define ZJS_PARAMS_10 ZJS_PARAMS_9, ZymValue a9

#define ZJS_DEFINE_FIXED_TRAMP(N) \
    static ZymValue zjs_fixed_tramp_##N(ZymVM* vm, ZymValue ctx ZJS_PARAMS_##N) { \
        const ZymValue* args; int arity; \
        ZymValue _argbuf[16]; (void)_argbuf; \
        ZymValue _a[] = { ZJS_ARGV_##N }; (void)_a; \
        args = _a; arity = N; \
        return zjs_dispatch(vm, ctx, arity, args, 0, NULL, 0); \
    }

/* The macro above won't quite work cleanly for N==0 (stray comma + 0 length
 * array); expand each trampoline explicitly for clarity and correctness. */

static ZymValue zjs_fixed_tramp_0(ZymVM* vm, ZymValue ctx) {
    return zjs_dispatch(vm, ctx, 0, NULL, 0, NULL, 0);
}
static ZymValue zjs_fixed_tramp_1(ZymVM* vm, ZymValue ctx, ZymValue a0) {
    ZymValue a[] = { a0 };
    return zjs_dispatch(vm, ctx, 1, a, 0, NULL, 0);
}
static ZymValue zjs_fixed_tramp_2(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1) {
    ZymValue a[] = { a0, a1 };
    return zjs_dispatch(vm, ctx, 2, a, 0, NULL, 0);
}
static ZymValue zjs_fixed_tramp_3(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2) {
    ZymValue a[] = { a0, a1, a2 };
    return zjs_dispatch(vm, ctx, 3, a, 0, NULL, 0);
}
static ZymValue zjs_fixed_tramp_4(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3) {
    ZymValue a[] = { a0, a1, a2, a3 };
    return zjs_dispatch(vm, ctx, 4, a, 0, NULL, 0);
}
static ZymValue zjs_fixed_tramp_5(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4) {
    ZymValue a[] = { a0, a1, a2, a3, a4 };
    return zjs_dispatch(vm, ctx, 5, a, 0, NULL, 0);
}
static ZymValue zjs_fixed_tramp_6(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue a5) {
    ZymValue a[] = { a0, a1, a2, a3, a4, a5 };
    return zjs_dispatch(vm, ctx, 6, a, 0, NULL, 0);
}
static ZymValue zjs_fixed_tramp_7(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue a5, ZymValue a6) {
    ZymValue a[] = { a0, a1, a2, a3, a4, a5, a6 };
    return zjs_dispatch(vm, ctx, 7, a, 0, NULL, 0);
}
static ZymValue zjs_fixed_tramp_8(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue a5, ZymValue a6, ZymValue a7) {
    ZymValue a[] = { a0, a1, a2, a3, a4, a5, a6, a7 };
    return zjs_dispatch(vm, ctx, 8, a, 0, NULL, 0);
}
static ZymValue zjs_fixed_tramp_9(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue a5, ZymValue a6, ZymValue a7, ZymValue a8) {
    ZymValue a[] = { a0, a1, a2, a3, a4, a5, a6, a7, a8 };
    return zjs_dispatch(vm, ctx, 9, a, 0, NULL, 0);
}
static ZymValue zjs_fixed_tramp_10(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue a5, ZymValue a6, ZymValue a7, ZymValue a8, ZymValue a9) {
    ZymValue a[] = { a0, a1, a2, a3, a4, a5, a6, a7, a8, a9 };
    return zjs_dispatch(vm, ctx, 10, a, 0, NULL, 0);
}

static void* const zjs_fixed_tramps[11] = {
    (void*)zjs_fixed_tramp_0,  (void*)zjs_fixed_tramp_1,  (void*)zjs_fixed_tramp_2,
    (void*)zjs_fixed_tramp_3,  (void*)zjs_fixed_tramp_4,  (void*)zjs_fixed_tramp_5,
    (void*)zjs_fixed_tramp_6,  (void*)zjs_fixed_tramp_7,  (void*)zjs_fixed_tramp_8,
    (void*)zjs_fixed_tramp_9,  (void*)zjs_fixed_tramp_10,
};

/* Variadic closure trampolines. Signature from native.h:
 *   ZymNativeClosureVariadicN: (VM*, Value ctx, N Values, Value* vargs, int vargc) */

static ZymValue zjs_var_tramp_0(ZymVM* vm, ZymValue ctx, ZymValue* vargs, int vargc) {
    return zjs_dispatch(vm, ctx, 0, NULL, 1, vargs, vargc);
}
static ZymValue zjs_var_tramp_1(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue* vargs, int vargc) {
    ZymValue a[] = { a0 };
    return zjs_dispatch(vm, ctx, 1, a, 1, vargs, vargc);
}
static ZymValue zjs_var_tramp_2(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue* vargs, int vargc) {
    ZymValue a[] = { a0, a1 };
    return zjs_dispatch(vm, ctx, 2, a, 1, vargs, vargc);
}
static ZymValue zjs_var_tramp_3(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue* vargs, int vargc) {
    ZymValue a[] = { a0, a1, a2 };
    return zjs_dispatch(vm, ctx, 3, a, 1, vargs, vargc);
}
static ZymValue zjs_var_tramp_4(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue* vargs, int vargc) {
    ZymValue a[] = { a0, a1, a2, a3 };
    return zjs_dispatch(vm, ctx, 4, a, 1, vargs, vargc);
}
static ZymValue zjs_var_tramp_5(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue* vargs, int vargc) {
    ZymValue a[] = { a0, a1, a2, a3, a4 };
    return zjs_dispatch(vm, ctx, 5, a, 1, vargs, vargc);
}
static ZymValue zjs_var_tramp_6(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue a5, ZymValue* vargs, int vargc) {
    ZymValue a[] = { a0, a1, a2, a3, a4, a5 };
    return zjs_dispatch(vm, ctx, 6, a, 1, vargs, vargc);
}
static ZymValue zjs_var_tramp_7(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue a5, ZymValue a6, ZymValue* vargs, int vargc) {
    ZymValue a[] = { a0, a1, a2, a3, a4, a5, a6 };
    return zjs_dispatch(vm, ctx, 7, a, 1, vargs, vargc);
}
static ZymValue zjs_var_tramp_8(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue a5, ZymValue a6, ZymValue a7, ZymValue* vargs, int vargc) {
    ZymValue a[] = { a0, a1, a2, a3, a4, a5, a6, a7 };
    return zjs_dispatch(vm, ctx, 8, a, 1, vargs, vargc);
}
static ZymValue zjs_var_tramp_9(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue a5, ZymValue a6, ZymValue a7, ZymValue a8, ZymValue* vargs, int vargc) {
    ZymValue a[] = { a0, a1, a2, a3, a4, a5, a6, a7, a8 };
    return zjs_dispatch(vm, ctx, 9, a, 1, vargs, vargc);
}
static ZymValue zjs_var_tramp_10(ZymVM* vm, ZymValue ctx, ZymValue a0, ZymValue a1, ZymValue a2, ZymValue a3, ZymValue a4, ZymValue a5, ZymValue a6, ZymValue a7, ZymValue a8, ZymValue a9, ZymValue* vargs, int vargc) {
    ZymValue a[] = { a0, a1, a2, a3, a4, a5, a6, a7, a8, a9 };
    return zjs_dispatch(vm, ctx, 10, a, 1, vargs, vargc);
}

static void* const zjs_var_tramps[11] = {
    (void*)zjs_var_tramp_0,  (void*)zjs_var_tramp_1,  (void*)zjs_var_tramp_2,
    (void*)zjs_var_tramp_3,  (void*)zjs_var_tramp_4,  (void*)zjs_var_tramp_5,
    (void*)zjs_var_tramp_6,  (void*)zjs_var_tramp_7,  (void*)zjs_var_tramp_8,
    (void*)zjs_var_tramp_9,  (void*)zjs_var_tramp_10,
};

/* Finalizer for native-context native_data: JS callback id is just an
 * integer, not an allocation, so there's nothing to free. We still install
 * a finalizer so the JS side can forget the entry in its callback map. */
static void zjs_native_ctx_finalizer(ZymVM* vm, void* data) {
    (void)vm;
    (void)data;
    /* Currently the JS side holds its callback map keyed by cb_id; when the
     * Zym closure is collected the JS side will simply retain the callback
     * until the VM is freed. A later patch can expose a hook here to notify
     * JS that a specific cb_id is collectible. */
}

/* -------------------------------------------------------------------------- */
/* Error callback                                                             */
/* -------------------------------------------------------------------------- */

static void zjs_error_cb(ZymVM* vm, ZymStatus type, const char* file, int line,
                         const char* message, void* user_data) {
    (void)user_data;
    zjs_js_on_error((uint32_t)(uintptr_t)vm, (int)type, file, line, message);
}

/* -------------------------------------------------------------------------- */
/* VM lifecycle                                                               */
/* -------------------------------------------------------------------------- */

ZymVM* zjs_newVM(void) {
    ZjsVMState* s = (ZjsVMState*)calloc(1, sizeof(*s));
    if (!s) return NULL;

    s->vm = zym_newVM(NULL);
    if (!s->vm) { free(s); return NULL; }

    s->handles_map = zym_newMap(s->vm);
    if (s->handles_map == ZYM_ERROR) {
        zym_freeVM(s->vm);
        free(s);
        return NULL;
    }
    /* Anchor the map in globals so the Zym GC keeps it alive. */
    if (zym_defineGlobal(s->vm, ZJS_HANDLE_MAP_GLOBAL, s->handles_map) != ZYM_STATUS_OK) {
        zym_freeVM(s->vm);
        free(s);
        return NULL;
    }

    if (!zjs_register_state(s)) {
        zym_freeVM(s->vm);
        free(s);
        return NULL;
    }

    zym_setErrorCallback(s->vm, zjs_error_cb, s);
    return s->vm;
}

void zjs_freeVM(ZymVM* vm) {
    ZjsVMState* s = zjs_find_state(vm);
    if (!s) return;
    zjs_unregister_state(s);
    zym_freeVM(s->vm);
    free(s);
}

/* -------------------------------------------------------------------------- */
/* Handle table (public surface)                                              */
/* -------------------------------------------------------------------------- */

void zjs_releaseHandle(ZymVM* vm, uint32_t handle) {
    ZjsVMState* s = zjs_find_state(vm);
    if (s) zjs_release(s, handle);
}

uint32_t zjs_valueKind(ZymVM* vm, uint32_t handle) {
    ZjsVMState* s = zjs_find_state(vm);
    if (!s) return ZJS_KIND_UNKNOWN;
    ZymValue v = zjs_get_handle(s, handle);
    if (zym_isNull(v))          return ZJS_KIND_NULL;
    if (zym_isBool(v))          return ZJS_KIND_BOOL;
    if (zym_isNumber(v))        return ZJS_KIND_NUMBER;
    if (zym_isString(v))        return ZJS_KIND_STRING;
    if (zym_isList(v))          return ZJS_KIND_LIST;
    if (zym_isMap(v))           return ZJS_KIND_MAP;
    if (zym_isStruct(v))        return ZJS_KIND_STRUCT;
    if (zym_isEnum(v))          return ZJS_KIND_ENUM;
    if (zym_isFunction(v))      return ZJS_KIND_FUNCTION;
    if (zym_isClosure(v))       return ZJS_KIND_CLOSURE;
    if (zym_isPromptTag(v))     return ZJS_KIND_PROMPT_TAG;
    if (zym_isContinuation(v))  return ZJS_KIND_CONTINUATION;
    return ZJS_KIND_UNKNOWN;
}

uint32_t zjs_newNull(ZymVM* vm) { (void)vm; return 0; }

uint32_t zjs_newBool(ZymVM* vm, int value) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zjs_alloc_handle(s, zym_newBool(value != 0));
}

uint32_t zjs_newNumber(ZymVM* vm, double value) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zjs_alloc_handle(s, zym_newNumber(value));
}

uint32_t zjs_newString(ZymVM* vm, const char* str, int len) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zjs_alloc_handle(s, zym_newStringN(vm, str, len));
}

uint32_t zjs_newList(ZymVM* vm) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zjs_alloc_handle(s, zym_newList(vm));
}

uint32_t zjs_newMap(ZymVM* vm) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zjs_alloc_handle(s, zym_newMap(vm));
}

int zjs_asBool(ZymVM* vm, uint32_t handle) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    ZymValue v = zjs_get_handle(s, handle);
    return zym_isBool(v) ? (zym_asBool(v) ? 1 : 0) : 0;
}

double zjs_asNumber(ZymVM* vm, uint32_t handle) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0.0;
    ZymValue v = zjs_get_handle(s, handle);
    return zym_isNumber(v) ? zym_asNumber(v) : 0.0;
}

const char* zjs_asString(ZymVM* vm, uint32_t handle, int* out_len) {
    ZjsVMState* s = zjs_find_state(vm);
    if (out_len) *out_len = 0;
    if (!s) return NULL;
    ZymValue v = zjs_get_handle(s, handle);
    const char* bytes = NULL;
    int bytelen = 0;
    if (!zym_toStringBytes(v, &bytes, &bytelen)) return NULL;
    if (out_len) *out_len = bytelen;
    return bytes;
}

/* Produce a Zym-formatted display string for any value (mirrors the output of
 * zym_printValue). Returns a new handle referencing a Zym string, or 0 on
 * failure. Used by the JS wrapper to render enums, structs, closures, etc.
 * without having to reimplement the VM's formatting rules in JS (and without
 * accidentally JSON.stringify-ing a ZymValue wrapper, which would traverse
 * the entire Emscripten Module via the back-pointer to the VM). */
uint32_t zjs_valueToString(ZymVM* vm, uint32_t handle) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    ZymValue v = zjs_get_handle(s, handle);
    ZymValue str = zym_valueToString(vm, v);
    if (str == ZYM_ERROR) return 0;
    return zjs_alloc_handle(s, str);
}

int zjs_listLength(ZymVM* vm, uint32_t list) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zym_listLength(zjs_get_handle(s, list));
}

uint32_t zjs_listGet(ZymVM* vm, uint32_t list, int index) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    ZymValue v = zym_listGet(vm, zjs_get_handle(s, list), index);
    if (v == ZYM_ERROR) return 0;
    return zjs_alloc_handle(s, v);
}

int zjs_listSet(ZymVM* vm, uint32_t list, int index, uint32_t value) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zym_listSet(vm, zjs_get_handle(s, list), index, zjs_get_handle(s, value)) ? 1 : 0;
}

int zjs_listAppend(ZymVM* vm, uint32_t list, uint32_t value) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zym_listAppend(vm, zjs_get_handle(s, list), zjs_get_handle(s, value)) ? 1 : 0;
}

int zjs_mapSize(ZymVM* vm, uint32_t map) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zym_mapSize(zjs_get_handle(s, map));
}

int zjs_mapHas(ZymVM* vm, uint32_t map, const char* key) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zym_mapHas(zjs_get_handle(s, map), key) ? 1 : 0;
}

uint32_t zjs_mapGet(ZymVM* vm, uint32_t map, const char* key) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    ZymValue v = zym_mapGet(vm, zjs_get_handle(s, map), key);
    if (v == ZYM_ERROR) return 0;
    return zjs_alloc_handle(s, v);
}

int zjs_mapSet(ZymVM* vm, uint32_t map, const char* key, uint32_t value) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zym_mapSet(vm, zjs_get_handle(s, map), key, zjs_get_handle(s, value)) ? 1 : 0;
}

int zjs_mapDelete(ZymVM* vm, uint32_t map, const char* key) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zym_mapDelete(vm, zjs_get_handle(s, map), key) ? 1 : 0;
}

/* zym_mapForEach callback used by zjs_mapKeys to accumulate keys into a
 * fresh list. We push one string per entry and ignore the value. */
typedef struct { ZymVM* vm; ZymValue list; } ZjsKeyCollect;
static bool zjs_collect_key(ZymVM* vm, const char* key, ZymValue val,
                            void* userdata) {
    (void)val;
    ZjsKeyCollect* ctx = (ZjsKeyCollect*)userdata;
    ZymValue k = zym_newString(vm, key);
    if (k == ZYM_ERROR) return true;  /* skip but continue */
    zym_listAppend(ctx->vm, ctx->list, k);
    return true;  /* continue iteration */
}

uint32_t zjs_mapKeys(ZymVM* vm, uint32_t map) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    ZymValue m = zjs_get_handle(s, map);
    ZymValue list = zym_newList(vm);
    if (list == ZYM_ERROR) return 0;
    zym_pushRoot(vm, list);
    ZjsKeyCollect ctx = { vm, list };
    zym_mapForEach(vm, m, zjs_collect_key, &ctx);
    zym_popRoot(vm);
    return zjs_alloc_handle(s, list);
}

const char* zjs_structName(ZymVM* vm, uint32_t handle) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return NULL;
    return zym_structGetName(zjs_get_handle(s, handle));
}

int zjs_structFieldCount(ZymVM* vm, uint32_t handle) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    return zym_structFieldCount(zjs_get_handle(s, handle));
}

const char* zjs_structFieldNameAt(ZymVM* vm, uint32_t handle, int index) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return NULL;
    return zym_structFieldNameAt(zjs_get_handle(s, handle), index);
}

uint32_t zjs_structGetField(ZymVM* vm, uint32_t handle, const char* name) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return 0;
    ZymValue v = zym_structGet(vm, zjs_get_handle(s, handle), name);
    if (v == ZYM_ERROR) return 0;
    return zjs_alloc_handle(s, v);
}

const char* zjs_enumTypeName(ZymVM* vm, uint32_t handle) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return NULL;
    return zym_enumGetName(vm, zjs_get_handle(s, handle));
}

const char* zjs_enumVariantName(ZymVM* vm, uint32_t handle) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return NULL;
    return zym_enumGetVariant(vm, zjs_get_handle(s, handle));
}

int zjs_enumVariantIndex(ZymVM* vm, uint32_t handle) {
    ZjsVMState* s = zjs_find_state(vm); if (!s) return -1;
    return zym_enumVariantIndex(vm, zjs_get_handle(s, handle));
}

/* -------------------------------------------------------------------------- */
/* Compilation / execution                                                    */
/* -------------------------------------------------------------------------- */

int zjs_compile(ZymVM* vm, const char* source, const char* entry_file,
                int include_line_info, ZymChunk** out_chunk) {
    if (out_chunk) *out_chunk = NULL;
    if (!vm) return ZJS_BRIDGE_ERROR;

    ZymChunk* chunk = zym_newChunk(vm);
    if (!chunk) return ZJS_BRIDGE_ERROR;
    ZymLineMap* map = include_line_info ? zym_newLineMap(vm) : NULL;

    ZymCompilerConfig cfg = { .include_line_info = include_line_info ? true : false };
    ZymStatus st = zym_compile(vm, source, chunk, map,
                               entry_file ? entry_file : "<script>", cfg);

    if (map) zym_freeLineMap(vm, map);

    if (st != ZYM_STATUS_OK) {
        zym_freeChunk(vm, chunk);
        return (int)st;
    }
    if (out_chunk) *out_chunk = chunk;
    return ZJS_OK;
}

int zjs_runChunk(ZymVM* vm, ZymChunk* chunk) {
    if (!vm || !chunk) return ZJS_BRIDGE_ERROR;
    return (int)zym_runChunk(vm, chunk);
}

void zjs_freeChunk(ZymVM* vm, ZymChunk* chunk) {
    if (!vm || !chunk) return;
    zym_freeChunk(vm, chunk);
}

int zjs_serializeChunk(ZymVM* vm, ZymChunk* chunk, int include_line_info,
                       char** out_buf, size_t* out_size) {
    if (out_buf) *out_buf = NULL;
    if (out_size) *out_size = 0;
    if (!vm || !chunk) return ZJS_BRIDGE_ERROR;
    ZymCompilerConfig cfg = { .include_line_info = include_line_info ? true : false };
    return (int)zym_serializeChunk(vm, cfg, chunk, out_buf, out_size);
}

void zjs_freeBytecode(char* buf) { free(buf); }

int zjs_deserializeChunk(ZymVM* vm, ZymChunk* chunk, const char* buf, size_t size) {
    if (!vm || !chunk || !buf) return ZJS_BRIDGE_ERROR;
    return (int)zym_deserializeChunk(vm, chunk, buf, size);
}

/* -------------------------------------------------------------------------- */
/* Globals / native registration / script calls                               */
/* -------------------------------------------------------------------------- */

int zjs_defineGlobal(ZymVM* vm, const char* name, uint32_t value_handle) {
    ZjsVMState* s = zjs_find_state(vm);
    if (!s || !name) return ZJS_BRIDGE_ERROR;
    return (int)zym_defineGlobal(vm, name, zjs_get_handle(s, value_handle));
}

/* Parse the trailing arity out of a signature like "foo(a, b, c)" so we can
 * pick the right trampoline. For variadic we return the fixed-arity prefix.
 * Very forgiving: counts commas outside parens, subtracting one for the
 * possible `...` token. */
static int zjs_parse_fixed_arity(const char* sig, int* is_variadic_out) {
    if (is_variadic_out) *is_variadic_out = 0;
    const char* p = strchr(sig, '(');
    if (!p) return -1;
    p++;

    /* Skip whitespace, check for "()" */
    while (*p == ' ' || *p == '\t') p++;
    if (*p == ')') return 0;

    int count = 1;        /* At least one param present. */
    int is_variadic = 0;
    int depth = 0;
    for (; *p && !(depth == 0 && *p == ')'); p++) {
        if (*p == '(') depth++;
        else if (*p == ')') depth--;
        else if (*p == ',' && depth == 0) count++;
        else if (*p == '.' && p[1] == '.' && p[2] == '.') is_variadic = 1;
    }
    if (is_variadic) { count--; }  /* `...` doesn't count as fixed param. */
    if (is_variadic_out) *is_variadic_out = is_variadic;
    return count;
}

static int zjs_register_native_impl(ZymVM* vm, const char* signature,
                                    uint32_t cb_id, int force_variadic) {
    ZjsVMState* s = zjs_find_state(vm);
    if (!s || !signature) return ZJS_BRIDGE_ERROR;

    int is_variadic = 0;
    int arity = zjs_parse_fixed_arity(signature, &is_variadic);
    if (force_variadic) is_variadic = 1;
    if (arity < 0 || arity > 10) return ZJS_BRIDGE_ERROR;

    ZymValue ctx = zym_createNativeContext(
        vm, (void*)(uintptr_t)cb_id, zjs_native_ctx_finalizer);
    if (zym_isNull(ctx)) return ZJS_BRIDGE_ERROR;
    zym_pushRoot(vm, ctx);

    void* fp = is_variadic ? zjs_var_tramps[arity] : zjs_fixed_tramps[arity];
    ZymValue closure = is_variadic
        ? zym_createNativeClosureVariadic(vm, signature, fp, ctx)
        : zym_createNativeClosure(vm, signature, fp, ctx);
    zym_popRoot(vm);
    if (zym_isNull(closure)) return ZJS_BRIDGE_ERROR;

    /* Extract the bare function name for the global binding. Copy until '('. */
    char name[256];
    size_t i = 0;
    for (; signature[i] && signature[i] != '(' && signature[i] != ' ' && i < sizeof(name) - 1; i++) {
        name[i] = signature[i];
    }
    name[i] = '\0';
    if (name[0] == '\0') return ZJS_BRIDGE_ERROR;

    if (zym_defineGlobal(vm, name, closure) != ZYM_STATUS_OK) return ZJS_BRIDGE_ERROR;
    return ZJS_OK;
}

int zjs_registerNative(ZymVM* vm, const char* signature, uint32_t cb_id) {
    return zjs_register_native_impl(vm, signature, cb_id, 0);
}

int zjs_registerNativeVariadic(ZymVM* vm, const char* signature, uint32_t cb_id) {
    return zjs_register_native_impl(vm, signature, cb_id, 1);
}

int zjs_callFunction(ZymVM* vm, const char* func_name, int argc,
                     const uint32_t* argv_handles, uint32_t* out_result) {
    if (out_result) *out_result = 0;
    ZjsVMState* s = zjs_find_state(vm);
    if (!s || !func_name) return ZJS_BRIDGE_ERROR;

    ZymValue argv_stack[16];
    ZymValue* argv = argv_stack;
    if (argc > 16) {
        argv = (ZymValue*)malloc(sizeof(ZymValue) * (size_t)argc);
        if (!argv) return ZJS_BRIDGE_ERROR;
    }
    for (int i = 0; i < argc; i++) argv[i] = zjs_get_handle(s, argv_handles[i]);

    ZymStatus st = zym_callv(vm, func_name, argc, argv);
    if (argv != argv_stack) free(argv);

    if (st != ZYM_STATUS_OK) return (int)st;

    if (out_result) {
        ZymValue r = zym_getCallResult(vm);
        *out_result = zjs_alloc_handle(s, r);
    }
    return ZJS_OK;
}

/* -------------------------------------------------------------------------- */
/* Native error propagation                                                   */
/* -------------------------------------------------------------------------- */

void zjs_setDispatchError(ZymVM* vm, const char* message) {
    ZjsVMState* s = zjs_find_state(vm);
    if (!s) return;
    if (!message) message = "";
    size_t cap = sizeof(s->last_dispatch_error);
    size_t n = strlen(message);
    if (n >= cap) n = cap - 1;
    memcpy(s->last_dispatch_error, message, n);
    s->last_dispatch_error[n] = '\0';
}

/* -------------------------------------------------------------------------- */
/* Build info                                                                 */
/* -------------------------------------------------------------------------- */

const char* zjs_version(void) { return "zym-js 0.1.0"; }
