const identity = require('keet-identity-key')
const b4a = require('b4a')

async function test() {
  

const mnemonic = 'increase hawk indoor antenna woman embark struggle venture design sleep safe loud delay adapt shiver rib slim rude language sniff hub palm omit recipe'

console.log(mnemonic)
const seed = await identity.deriveSeed(mnemonic)
const pseed = b4a.toString(seed, 'hex')
console.log(pseed)

}

test()