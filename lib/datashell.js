// Datashell code
// Loads identity module and executes app code with identity vault

const identity = require('identity')

// as we're using bare, we need to conditionally require process
const process = globalThis.open ? null : require('bare-process')
const run = globalThis.open ? web : cli

run(identity)

async function web (identity) {
  const env = Object.fromEntries(new URLSearchParams(location.search).entries())
  const args1 = location.hash.slice(1).split('#').filter(x => x)
  const args2 = document.currentScript.src.split('#').slice(1).filter(x => x)
  const args3 = ['bundle.js']
  const args = args1.length ? args1 : args2.length ? args2 : args3
  const [app, ...arg] = args
  console.log('[datashell] Debug - args1:', args1, 'args2:', args2, 'args3:', args3)
  console.log('[datashell] Debug - final args:', args, 'app:', app)
  const config = { ...env, args: arg }
  const loader = await webload(app)
  const identity_api = identity(config)
  console.log('[datashell] Identity API created:', identity_api)
  console.log('[datashell] Calling loader with identity_api...')
  try {
    await loader(identity_api)
    console.log('[datashell] Loader completed successfully')
  } catch (err) {
    console.error('[datashell] Loader error:', err)
  }
}

function cli (identity) {
  const env = process.env
  const args1 = ['./cliapp-ui.js', ...process.argv.slice(2)]
  const args2 = ['./cliapp-ui.js']
  const args = (args1.length && args1) || args2
  const [app, ...arg] = args
  const config = { ...env, args: arg }
  const loader = require(app)
  const identity_api = identity(config)
  console.log('[datashell] Identity API created:', identity_api)
  loader(identity_api)
}

async function webload (app) {
  const url = new URL(app, location)
  console.log('[datashell] Fetching app from URL:', url.href)
  const response = await fetch(url, { cache: 'no-cache' })
  console.log('[datashell] Response status:', response.status, response.statusText)
  console.log('[datashell] Response content-type:', response.headers.get('content-type'))
  const src = await response.text()
  console.log('[datashell] Source length:', src.length, 'First 100 chars:', src.slice(0, 100))
  const AsyncFunction = (async () => { }).constructor
  return new AsyncFunction('vault', src)
}
