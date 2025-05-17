const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const process = require('bare-process')

const topic_hex = 'ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021'
const topic = b4a.from(topic_hex, 'hex')

start();

async function start() {
  const args = process.argv.slice(2);
  const name_index = args.indexOf('--name')
  const peer_name = name_index !== -1 ? args[name_index + 1] : 'anonymous'

  const swarm = new Hyperswarm()
  const discovery = swarm.join(topic, { server: true, client: true })
  await discovery.flushed()

  console.log(`Joined swarm as ${peer_name}, Listening for peers...`)

  swarm.on('connection', (socket, info) => {
  socket.write(peer_name + '\n'); 

  let remote_name = 'unknown'

  socket.once('data', (data) => {
  remote_name = data.toString().trim()
  console.log(`${remote_name} joined`)
    });

  console.log(`Connected to new peer. Total: ${swarm.connections.size}`)

  socket.on('close', () => {
    console.log(`${remote_name} disconnected`)
    console.log(`Remaining connections: ${swarm.connections.size}`)
    })

  socket.on('error', (err) => {
    console.log('Socket error:', err.message);
    });
  });
}
