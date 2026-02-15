#!/usr/bin/env bare

// cli system ui, handles authentication for CLI
// this is system level, not app specific

module.exports = function system (vault) {
  const process = require('bare-process')

  console.log('[clisys-ui] Starting CLI system UI')

  // Parse CLI arguments
  function parse_args (args) {
    const parsed = {}
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--name') {
        parsed.name = args[i + 1]
        i++
      } else if (args[i] === '--pair') {
        parsed.pair_mode = true
        parsed.invite_code = args[i + 1]
        i++
      } else if (args[i] === '--load') {
        parsed.load_mode = true
        parsed.mnemonic = args[i + 1]
        i++
      }
    }
    return parsed
  }

  const cli_args = process.argv.slice(2)
  const parsed_args = parse_args(cli_args)

  // Generate default username if not provided
  if (!parsed_args.name && !parsed_args.pair_mode) {
    const hostname = process.env.HOSTNAME || 'unknown'
    const timestamp = Date.now().toString().slice(-4)
    parsed_args.name = `${hostname}-${timestamp}`
    console.log(`Generated username: ${parsed_args.name}`)
  }

  // Handle authentication based on mode
  if (parsed_args.pair_mode) {
    // Pair mode
    console.log('=== Pairing Mode ===')
    console.log('Pairing with invite code...')

    vault.authenticate({
      username: parsed_args.name || 'pairing-user',
      mode: 'pair',
      invite_code: parsed_args.invite_code
    })
  } else if (parsed_args.load_mode) {
    // Load from mnemonic mode
    console.log('=== Load Mode ===')
    console.log('Loading from mnemonic...')

    // TODO: Implement mnemonic loading
    console.log('Mnemonic loading not implemented yet')
    process.exit(1)
  } else {
    // Seed mode (create new)
    console.log('=== Seed Mode ===')
    console.log(`Creating new account: ${parsed_args.name}`)

    vault.authenticate({
      username: parsed_args.name,
      mode: 'seed'
    })
  }
}
