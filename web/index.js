const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const HyperWebRTC = require('hyper-webrtc')
const Protomux = require('protomux')
const c = require('compact-encoding')

const topic_hex = 'ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021'
const topic = b4a.from(topic_hex, 'hex')
const peer_name = 'browser'

start()

async function start () {
  const socket = new WebSocket('ws://localhost:8080')

  socket.addEventListener('open', async () => {
    console.log('Connected to DHT relay')

    const dht = new DHT(new Stream(true, socket))
    const swarm = new Hyperswarm({ dht })

    const discovery = swarm.join(topic, { server: true, client: true })
    await discovery.flushed()
    console.log(`Joined swarm as ${peer_name}`)

    // Refresh discovery every 5 seconds
    setInterval(() => {
      swarm.join(topic, { server: true, client: true }).flushed().then(() => {
        console.log('Refreshed discovery')
      })
    }, 5000)

    swarm.on('connection', (conn, info) => {
      conn.write(peer_name + '\n')

      let remote_name = 'unknown'

      conn.once('data', (data) => {
        remote_name = b4a.toString(data).trim()
        console.log(`${remote_name} joined`)

        const mux = new Protomux(conn)

        const check = mux.createChannel({
          protocol: 'chat-message',
          onopen () {
            console.log('Upgrade channel opened with peer')
          },
          onclose () {
            console.log('Upgrade channel closed with peer')
          }
        })

        const msg = check.addMessage({
          encoding: c.string,
          onmessage (m) {
            console.log('Received data from peer:', m)

           
            let parsed
            try {
              parsed = JSON.parse(m)
            } catch {
              console.log('Received non-JSON message:', m)
              return
            }

            if (parsed.type === 'protocol' && parsed.data === 'native') {
              console.log('Native peer detected, using Protomux over socket.')

              const mux = new Protomux(conn)

              const chat = mux.createChannel({
                protocol: 'chat-message',
                onopen () {
                  console.log('Protocol channel opened with native peer')
                },
                onclose () {
                  console.log('Protocol channel closed with native peer')
                }
              })

              const msg = chat.addMessage({
                encoding: c.string,
                onmessage (m) {
                  console.log('Received reply from native peer:', m)
                }
              })

              chat.open()
              setTimeout(() => {
                msg.send('Hello native peer from browser via Protomux')
              }, 1000)

            } else if (parsed.type === 'protocol' && parsed.data === 'webrtc') {
              console.log('Upgrading connection to WebRTC...')

              const rtc = HyperWebRTC.from(conn)

              rtc.on('open', () => {
                console.log('WebRTC stream established with', remote_name)

                const mux = new Protomux(rtc)

                const chat = mux.createChannel({
                  protocol: 'chat-message',
                  onopen () {
                    console.log('Protocol channel opened')
                  },
                  onclose () {
                    console.log('Protocol channel closed')
                  }
                })

                const msg = chat.addMessage({
                  encoding: c.string,
                  onmessage (m) {
                    console.log('Received message:', m)
                  }
                })

                chat.open()
                setTimeout(() => {
                  msg.send('Hello from browser via Protomux')
                }, 1000)
              })

              rtc.on('error', (err) => {
                console.log('WebRTC error:', err.message)
              })

              rtc.on('close', () => {
                console.log('WebRTC connection closed with', remote_name)
              })
            }
          }
        })

        check.open()
        setTimeout(() => {
         
          msg.send(JSON.stringify({ type: 'protocol', data: 'webrtc' }))
        }, 1000)
      })

      conn.on('close', () => {
        console.log(`${remote_name} disconnected`)
      })

      conn.on('error', (err) => {
        console.log('Socket error:', err.message)
      })
    })
  })
}

