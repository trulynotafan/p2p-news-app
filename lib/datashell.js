// Datashell code
// Loads identity module and executes app code with identity vault

;(globalThis.open
  ? boot(loadweb, inputweb('system.js', 'bundle.js'))
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
  // Wrap vault for the app — auto-namespace so app never sees its APP_ID
  const app_instance_id = 'p2p-news-app' // @TODO: dynamic from websys-ui app launcher
  // I have mentioned this on discord
  const app_vault = create_app_vault(uservault, app_instance_id)
  app(app_vault)
}

/***************************************
APP VAULT WRAPPER
Provides a namespaced vault so the app thinks it's the only one.
All vault_put/vault_get calls auto-prefix with app_instance_id.
All app-scoped identity calls auto-pass app_instance_id.
***************************************/
function create_app_vault (vault, app_instance_id) {
  return {
    ...vault,
    // Auto-namespaced data operations
    vault_put: (key, value) => vault.vault_put(`${app_instance_id}/${key}`, value),
    vault_get: (key) => vault.vault_get(`${app_instance_id}/${key}`),
    vault_del: (key) => vault.vault_del(`${app_instance_id}/${key}`),
    // Auto-scoped app operations
    register_app: (config) => vault.register_app(app_instance_id, config),
    get_app: () => vault.get_app(app_instance_id),
    get_app_audit: () => vault.get_app_audit(app_instance_id),
    load_app_audit: (key) => vault.load_app_audit(app_instance_id, key),
    start_writer_watcher: () => vault.start_writer_watcher(app_instance_id),
    request_writer_access: () => vault.request_writer_access(app_instance_id),
    wait_for_writer_access: () => vault.wait_for_writer_access(app_instance_id),
    log_bootstrap_device: () => vault.log_bootstrap_device(app_instance_id)
  }
}
