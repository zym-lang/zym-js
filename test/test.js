const script = `
    var a = "I Like Pie!"
    print(a)
`

import Zym from "../js/zym.mjs"

const vm = await Zym.newVM()

vm.registerNative("print(msg)", (msg) => {
    console.log(msg.toJS())
    return null
})

vm.run(script)

vm.free()