#!/usr/bin/env bare

// bin/cli.js

const bare_peer = require('../src/node_modules/bare-peer/index.js')
const process = require('bare-process')

bare_peer.start(process.argv.slice(2))
  .then(() => console.log('Native peer CLI started successfully.'))
  .catch(err => {
    console.error('Failed to start native peer CLI:', err)
    process.exit(1)
  })
