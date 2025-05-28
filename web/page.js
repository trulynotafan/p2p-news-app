const web_peer = require('../src/node_modules/web-peer/index.js')

console.log('Starting web peer from web/page.js...')

web_peer.start({ name: 'web-peer' })
  .then(() => console.log('Web peer started successfully.'))
  .catch(err => console.error('Failed to start web peer:', err))
