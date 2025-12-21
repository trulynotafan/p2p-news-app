// Datashell code
// Loads identity module and executes app code with identity vault

;(globalThis.open ? boot(loadweb, inputweb('system.js', 'bundle.js'))
                  : boot(loadcli, inputcli('./clisys-ui.js', './cliapp-ui.js'))
).catch(onerror)

function onerror (error) {
  console.error('[datashell] Loader error:', error)
}

function inputcli (sysurl, appurl) {
  const process = require('bare-process')
  const env = process.env
  const args1 = [sysurl, appurl, ...process.argv.slice(2)]
  const args2 = [sysurl, appurl]
  const arg = args1.length ? args1 : args2
  return { env, arg }
}

function inputweb (sysurl, appurl) {
  const env = Object.fromEntries(new URLSearchParams(location.search).entries())
  const args1 = location.hash.slice(1).split('#').filter(x => x)
  const args2 = document.currentScript.src.split('#').slice(1).filter(x => x)
  const args3 = [sysurl, appurl]
  const arg = args1.length ? args1 : args2.length ? args2 : args3
  return { env, arg }
}

async function loadcli (href) {
  // Use eval to avoid browserify trying to bundle bare-fs
  const fs = eval('require')('bare-fs')
  const src = fs.readFileSync(href)
  const async_function = (async () => {}).constructor
  return new async_function('vault', src)
}

async function loadweb (href) {
  const url = new URL(href, location)
  const response = await fetch(url, { cache: 'no-cache' })
  const src = await response.text()
  const async_function = (async () => {}).constructor
  return new async_function('vault', src)
}

async function boot (load, input) {
  const identity = require('identity')
  const vault = identity(input)
  const [sysurl, appurl] = input.arg
  const system = await load(sysurl)
  await system(vault)
  const uservault = await vault.user
  if (!appurl) return
  const app = await load(appurl)
  app(uservault)
}