cmake_minimum_required(VERSION 3.20)
project(zym_js C)

set(CMAKE_C_STANDARD 11)

#set(CMAKE_BUILD_TYPE MinSizeRel)
#set(CMAKE_BUILD_TYPE Release)

# Pull in zym_core (lives in this repo as a subdirectory)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/zym_core
                 ${CMAKE_CURRENT_BINARY_DIR}/zym_core)

# zym_js: the wasm module that JS loads. main.c is a tiny smoke entry point
# that also keeps a few handy runtime symbols exported; zym_js_api.c is the
# real JS bridge.
add_executable(zym_js
    src/main.c
    src/zym_js_api.c
)
target_link_libraries(zym_js PRIVATE zym_core)
# Bridge implementation needs zym/zym.h from the library's public include dir
# and (optionally) the shim header from our own src/.
target_include_directories(zym_js PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Size optimization: use MinSizeRel for the smallest possible binary
# -Oz = aggressive size optimization (smaller than -Os)
# -flto = link-time optimization (lets the linker eliminate more dead code)
if(CMAKE_BUILD_TYPE STREQUAL "MinSizeRel")
    target_compile_options(zym_js   PRIVATE -Oz -flto -fno-asynchronous-unwind-tables -fno-unwind-tables)
    target_compile_options(zym_core PRIVATE -Oz -flto -fno-asynchronous-unwind-tables -fno-unwind-tables)
    set(WASM_OPT_FLAGS "-Oz -flto")
    # Closure Compiler (--closure 1) further shrinks the JS glue but requires
    # the `closure-compiler` binary on PATH. Opt-in via -DZYM_JS_CLOSURE=ON so
    # builds don't fail for users who don't have it installed.
    option(ZYM_JS_CLOSURE "Run Google Closure Compiler on the JS glue (requires `closure-compiler` on PATH)" OFF)
    if(ZYM_JS_CLOSURE)
        set(WASM_OPT_FLAGS "${WASM_OPT_FLAGS} --closure 1")
    endif()
else()
    set(WASM_OPT_FLAGS "-O3 -flto")
endif()

# -----------------------------------------------------------------------------
# Exported symbols
#
# `_zjs_*` covers the full JS-bridge surface declared in src/zym_js_api.h.
# `_malloc` / `_free` are kept so JS can allocate UTF-8 / bytecode buffers
# in wasm memory before handing them to the shim. `_main` is kept so the
# smoke-test entry point (src/main.c) still runs when the module is loaded
# without explicit ccall usage.
# -----------------------------------------------------------------------------
set(ZJS_EXPORTED_FUNCS
    "_main"
    "_malloc"
    "_free"
    "_zjs_newVM"
    "_zjs_freeVM"
    "_zjs_releaseHandle"
    "_zjs_valueKind"
    "_zjs_newNull"
    "_zjs_newBool"
    "_zjs_newNumber"
    "_zjs_newString"
    "_zjs_newList"
    "_zjs_newMap"
    "_zjs_asBool"
    "_zjs_asNumber"
    "_zjs_asString"
    "_zjs_valueToString"
    "_zjs_listLength"
    "_zjs_listGet"
    "_zjs_listSet"
    "_zjs_listAppend"
    "_zjs_mapSize"
    "_zjs_mapHas"
    "_zjs_mapGet"
    "_zjs_mapSet"
    "_zjs_mapDelete"
    "_zjs_mapKeys"
    "_zjs_structName"
    "_zjs_structFieldCount"
    "_zjs_structFieldNameAt"
    "_zjs_structGetField"
    "_zjs_enumTypeName"
    "_zjs_enumVariantName"
    "_zjs_enumVariantIndex"
    "_zjs_compile"
    "_zjs_runChunk"
    "_zjs_freeChunk"
    "_zjs_serializeChunk"
    "_zjs_freeBytecode"
    "_zjs_deserializeChunk"
    "_zjs_defineGlobal"
    "_zjs_registerNative"
    "_zjs_registerNativeVariadic"
    "_zjs_callFunction"
    "_zjs_setDispatchError"
    "_zjs_version"
)
string(REPLACE ";" "," ZJS_EXPORTED_FUNCS_CSV "${ZJS_EXPORTED_FUNCS}")

set(ZJS_RUNTIME_METHODS
    "ccall"
    "cwrap"
    "UTF8ToString"
    "stringToUTF8"
    "lengthBytesUTF8"
    "HEAPU8"
    "HEAP32"
    "HEAPU32"
    "HEAPF64"
    "getValue"
    "setValue"
)
string(REPLACE ";" "," ZJS_RUNTIME_METHODS_CSV "${ZJS_RUNTIME_METHODS}")

# Emscripten link flags:
#   MODULARIZE + EXPORT_ES6 + EXPORT_NAME -> produces an ESM default export
#   createZymModule() that resolves to the initialized Module instance.
#   ENVIRONMENT=web,node,worker lets the same file work in every target
#   runtime without Node-specific assumptions.
set_target_properties(zym_js PROPERTIES
    SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/dist"
    LINK_FLAGS "\
        -s EXPORTED_FUNCTIONS=[${ZJS_EXPORTED_FUNCS_CSV}] \
        -s EXPORTED_RUNTIME_METHODS=[${ZJS_RUNTIME_METHODS_CSV}] \
        -s MODULARIZE=1 \
        -s EXPORT_ES6=1 \
        -s EXPORT_NAME='createZymModule' \
        -s ENVIRONMENT=web,node,worker \
        -s ALLOW_MEMORY_GROWTH=1 \
        -s TOTAL_STACK=1048576 \
        -s INITIAL_MEMORY=4194304 \
        -s STACK_OVERFLOW_CHECK=0 \
        -s ALLOW_TABLE_GROWTH=0 \
        -s DYNAMIC_EXECUTION=0 \
        -s INVOKE_RUN=0 \
        -s FILESYSTEM=0 \
        -s ASSERTIONS=0 \
        ${WASM_OPT_FLAGS} \
    "
)
