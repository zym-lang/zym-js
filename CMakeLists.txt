cmake_minimum_required(VERSION 3.20)
project(zym_js C)

set(CMAKE_C_STANDARD 11)

# Pull in zym_core (lives in this repo as a subdirectory)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/zym_core
                 ${CMAKE_CURRENT_BINARY_DIR}/zym_core)

add_executable(zym_js src/main.c)
target_link_libraries(zym_js PRIVATE zym_core)

# Size optimization: use MinSizeRel for the smallest possible binary
# -Oz = aggressive size optimization (smaller than -Os)
# -flto = link-time optimization (lets the linker eliminate more dead code)
if(CMAKE_BUILD_TYPE STREQUAL "MinSizeRel")
    target_compile_options(zym_js   PRIVATE -Oz -flto -fno-asynchronous-unwind-tables -fno-unwind-tables)
    target_compile_options(zym_core PRIVATE -Oz -flto -fno-asynchronous-unwind-tables -fno-unwind-tables)
    set(WASM_OPT_FLAGS "-Oz -flto --closure 1")
else()
    set(WASM_OPT_FLAGS "-O3 -flto")
endif()

# Emscripten link flags — emits zym_js.js + zym_js.wasm
# Start with just main + malloc/free; add more exports as you build out the JS API.
set_target_properties(zym_js PROPERTIES
    SUFFIX ".js"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/dist"
    LINK_FLAGS "\
        -s EXPORTED_FUNCTIONS=['_main','_malloc','_free'] \
        -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap'] \
        -s MODULARIZE=1 \
        -s EXPORT_NAME='ZymJsModule' \
        -s ALLOW_MEMORY_GROWTH=1 \
        -s TOTAL_STACK=1048576 \
        -s INITIAL_MEMORY=4194304 \
        -s STACK_OVERFLOW_CHECK=0 \
        ${WASM_OPT_FLAGS} \
    "
)
