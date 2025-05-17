const { WebSocketServer } = require('ws')
const DHT = require('hyperdht')
const { relay } = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')

const dht = new DHT()
const server = new WebSocketServer({ port: 8080 })

console.log('Relay running on ws://localhost:8080')

server.on('connection', (socket) => {
  try {
  const stream = new Stream(false, socket)
  stream.on('error', (err) => {
  console.log('[stream error]', err.message)
  })

  socket.on('close', () => {
  console.log('[socket closed]')
  })

 relay(dht, stream)
  } catch (err) {
  console.log('[relay setup error]', err.message)
  }
})
