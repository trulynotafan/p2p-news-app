const env = { version: 'latest' }
const arg = { x: 321, y: 543 }
const url = 'https://playproject.io/datashell/shim.js'
const src = `${url}?${new URLSearchParams(env)}#${new URLSearchParams(arg)}`
// eslint-disable-next-line no-undef
this.open ? document.body.append(Object.assign(document.createElement('script'), { src })) : importScripts(src)
