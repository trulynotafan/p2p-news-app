#!/usr/bin/env bare

// bin/cli.js

const bare_peer = require('../src/node_modules/bare-peer/index.js')
const process = require('bare-process')

// CHANGED: Moved CLI parsing logic HERE instead of inside bare-peer module
// bare-peer can now be reused without CLI args
function parse_cli_args(args) {
  const arr = []
  for (let i = 0; i < args.length; i += 2) arr.push([args[i], args[i + 1]])
  return Object.fromEntries(arr)
}

function validate_cli_args(opts) {
  if (!opts['--name']) console.warn('Warning: --name not provided. Using default name.')
  return opts
}

// Parse CLI args here and convert to clean options object
const cli_args = process.argv.slice(2)
const parsed_args = parse_cli_args(cli_args)
const validated_args = validate_cli_args(parsed_args)

// Create clean options object instead of passing raw CLI args
const options = {
  name: validated_args['--name'] || `native-peer-${process.pid}`
}

// Pass options object instead of CLI args array
bare_peer.start(options)
  .then(() => console.log('Native peer CLI started successfully.'))
  .catch(err => {
    console.error('Failed to start native peer CLI:', err)
    process.exit(1)
  })