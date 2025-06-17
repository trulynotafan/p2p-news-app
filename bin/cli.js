#!/usr/bin/env bare

const bare_peer = require('../src/node_modules/bare-peer/index.js')
const process = require('bare-process')

function parse_cli_args(args) {
  const parsed = {}
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') {
      parsed.name = args[i + 1]
      if (!parsed.name || parsed.name.startsWith('--')) {
        console.error("--name requires a name as an argument, duh.")
        process.exit(1)
      }
      i++
    } else if (args[i] === '--invite') {
      parsed.mode = 'invite'
    } else if (args[i] === '--pair') {
      const inviteKeyHex = args[i + 1]
      if (!inviteKeyHex || inviteKeyHex.startsWith('--')) {
        console.error("You didn't provde the autobase key bro")
        process.exit(1)
      }
      parsed.mode = 'pair'
      parsed.inviteKey = inviteKeyHex
      i++
    } else if (args[i] === '--auto' || args[i] === '-a') {
      parsed.auto = true
    }
  }
  
  return parsed
}

function validate_cli_args(opts) {

  if ((opts.mode === 'invite' || opts.mode === 'pair') && !opts.name) {
    console.error('--name is required when using --invite or --pair modes')
    process.exit(1)
  }

  if (opts.mode === 'pair' && !opts.inviteKey) {
    console.error('pair requires and autobase invite key')
    process.exit(1)
  }

  if (!opts.name && !opts.mode) {
    const hostname = process.env.HOSTNAME || 'unknown'
    const timestamp = Date.now().toString().slice(-4)
    opts.name = `${hostname}-${timestamp}`
    console.log(`Generated Random device name: ${opts.name}`)
  }

  return opts
}

const cli_args = process.argv.slice(2)
const parsed_args = parse_cli_args(cli_args)
const validated_args = validate_cli_args(parsed_args)

// Show auto-detection info
if (!validated_args.mode || validated_args.auto) {
  console.log('Auto-detection mode: First run becomes main, next runs auto-detect role')
}

// Start the peer
const options = {
  name: validated_args.name,
  mode: validated_args.mode,
  inviteKey: validated_args.inviteKey
}

console.log('Starting peer:', options.name, options.mode || 'auto-detect')

bare_peer.start(options)
  .then(() => console.log('Peer started - Press Ctrl+C to stop'))
  .catch(err => {
    console.error(':( Failed to start peer:', err)
    process.exit(1)
  })