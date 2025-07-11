# P2P Blog App: Architecture & Code Walkthrough

---



## Overview

This P2P blog app is a decentralized, browser-based blogging platform. Each user runs a local peer that can:
- Create and publish blog posts
- Discover other peers on the network
- Subscribe to other blogs and sync their posts
- Use WebRTC and DHT relays for peer-to-peer connections
- Store all data locally (no central server)

The app is built on top of the [Hypercore Protocol](https://hypercore-protocol.org/) ecosystem, using modules like Hypercore, Hyperdrive, Hyperswarm, and more.

---

## Key Technologies & Modules

### 1. **Hypercore**
- **What:** An append-only, cryptographically signed log (like a blockchain, but simpler).
- **Role:** Stores the sequence of blog events (init, posts, subscriptions, etc.) for each user.
- **Example:**
  ```js
  const core = store.get({ name: 'blog-feed' })
  await core.ready()
  await core.append(JSON.stringify({ type: 'blog-post', ... }))
  ```

### 2. **Hyperdrive**
- **What:** A secure, real time distributed file system
- **Role:** Stores blog post contents as files (e.g., `/posts/123.md`).
- **Example:**
  ```js
  const drive = new Hyperdrive(store)
  await drive.ready()
  await drive.put('/posts/123.md', Buffer.from('Hello world!'))
  ```

### 3. **Hyperswarm**
- **What:** A distributed networking stack for connecting peers.
- **Role:** Finds and connects to other peers in the network.
- **Example:**
  ```js
  const swarm = new Hyperswarm({ dht })
  swarm.join(topic, { server: true, client: true })
  swarm.on('connection', (conn) => { ... })
  ```

### 4. **Protomux**
- **What:** A multiplexing protocol for multiple logical channels over a single connection.
- **Role:** Handles identity exchange and protocol negotiation between peers.
- **Example:**
  ```js
  const mux = new Protomux(conn)
  const channel = mux.createChannel({ protocol: 'identity-exchange', ... })
  ```

### 5. **HyperWebRTC**
- **What:** WebRTC wrapper for Hypercore Protocol, enabling browser-to-browser P2P connections.
- **Role:** Establishes direct connections between browsers for data replication.
- **Example:**
  ```js
  const stream = HyperWebRTC.from(relay, { initiator: relay.isInitiator })
  store.replicate(stream, { live: true, encrypt: true, download: true })
  ```

### 6. **Corestore**
- **What:** Manages multiple Hypercore/Hyperdrive instances and their storage.
- **Role:** Provides a unified API for all data storage in the app.
- **Example:**
  ```js
  const store = new Corestore(RAW('blogs-username'))
  ```

### 7. **random-access-web**
- **What:** Storage adapter for browsers (IndexedDB, Random access chrome file etc.).
- **Role:** Persists all Hypercore/Hyperdrive data in the browser.
- **Example:**
  ```js
  const RAW = require('random-access-web')
  const store = new Corestore(RAW('blogs-username'))
  ```

---

## Main Files & Their Roles

### web/page.js
**Role:** The main browser UI and event handler. Handles login, navigation, rendering, and user actions.

**Key responsibilities:**
- Renders the app UI (login, news, blog, explore, post, config)
- Handles user events (join, publish, subscribe, unsubscribe, reset)
- Calls into `blog_helper` for all blog/peer logic
- Listens for updates and re-renders views

**Example: Rendering the News Feed**
```js
const my_posts = await blog_helper.get_my_posts()
const peer_blogs = await blog_helper.get_peer_blogs()
const posts = [
  ...my_posts.map(p => ({...p, is_own: true})),
  ...Array.from(peer_blogs.entries()).flatMap(([key, peer]) =>
    (peer.posts || []).map(p => ({...p, peer_key: key, peer_name: peer.username || 'Unknown'}))
  )
].sort((a, b) => b.created - a.created)
```

**How it interacts:**
- On login, calls `start_browser_peer` and `blog_helper.init_blog`
- On subscribe/unsubscribe, calls `blog_helper.subscribe`/`unsubscribe`
- On new peer discovery, listens for events and updates the UI

---

### helpers/blog-helpers/index.js
**Role:** All blog logic, peer management, subscription, and post sync.

**Key responsibilities:**
- Initializes the user's blog and Hyperdrive
- Handles peer discovery and maintains a list of connected peers
- Manages subscriptions (using localStorage for fast lookups)
- Downloads and syncs posts from peers
- Emits update events for UI refresh

**Example: Subscribing to a Peer**
```js
async function subscribe(key) {
  const peer_core = store.get(b4a.from(key, 'hex'))
  await peer_core.ready()
  // ... download posts, set up listeners ...
  add_local_subscribed_peer(key)
}
```

**How it interacts:**
- Called by the UI for all blog/peer actions
- Listens for new cores (peers) and manages re-listening
- Uses append-only logs for post history, but localStorage for subscriptions

---

### web-peer/index.js
**Role:** Handles peer connection, relay, DHT, swarm, and protocol setup.

**Key responsibilities:**
- Sets up the DHT relay and Hyperswarm
- Manages WebRTC and relay connections
- Handles protocol negotiation and identity exchange
- Emits discovered cores to the store

**Example: Swarm Join and Connection**
```js
const swarm = new Hyperswarm({ dht })
swarm.join(topic, { server: true, client: true })
swarm.on('connection', (relay, details) => {
  // Setup Protomux, identity exchange, and replication
})
```

**How it interacts:**
- Used by the UI to start the peer and get the store
- Emits 'core' events for each discovered peer

---

### helpers/protocol-helpers/index.js
**Role:** Protomux protocol and identity exchange logic.

**Key responsibilities:**
- Sets up a Protomux channel for identity and protocol negotiation
- Handles protocol, feedkey, and other messages

**Example: Identity Exchange**
```js
const channel = mux.createChannel({
  protocol: 'identity-exchange',
  onopen: () => { ... }
})
```

---

### helpers/crypto-helpers/index.js
**Role:** Key management, mnemonic generation, save/load.

**Key responsibilities:**
- Generates and saves mnemonic keypairs
- Loads keys from localStorage or file
- Provides cryptographic utilities for the app

**Example: Creating a Keypair**
```js
const { mnemonic, keypair } = await create_mnemonic_keypair({ namespace: 'noisekeys', name: 'noise' })
```

---

### relay/index.js
**Role:** Simple relay server for browser peers.

**Key responsibilities:**
- Runs a WebSocket server
- Relays DHT traffic for Hyperswarm

**Example:**
```js
const server = new WebSocketServer({ port: 8080 })
server.on('connection', (socket) => {
  relay(dht, stream)
})
```

---

## How It All Works: Step by Step

### 1. Starting the App & Joining the Network
- User enters a username and clicks Join.
- `page.js` calls `start_browser_peer` (web-peer/index.js), which:
  - Loads/generates a keypair
  - Sets up Corestore, DHT, Hyperswarm, and WebRTC
  - Joins the swarm and starts discovering peers
- `blog_helper.init_blog` initializes the user's blog and Hyperdrive.

### 2. Peer Discovery & Swarm
- Peers are discovered via Hyperswarm and DHT relay.
- For each new peer, a Protomux channel is set up for identity exchange.
- When a peer's blog core is found, a 'core' event is emitted.
- `blog_helper.handle_new_core` processes the new peer, adds to the list, and (if previously subscribed) re-establishes listeners.

### 3. Subscribing to Peers & Listening
- User clicks Subscribe in the UI.
- `blog_helper.subscribe`:
  - Downloads all posts from the peer's core and drive
  - Sets up listeners for new posts
  - Adds the peer key to localStorage for fast reconnection
- When a subscribed peer reconnects, listeners are re-established automatically.

### 4. Creating and Syncing Posts
- User creates a post in the UI.
- `blog_helper.create_post` appends a new entry to the user's blog core and stores the content in Hyperdrive.
- Other peers subscribed to this user will download the new post when they see the update.

### 5. Data Reset & Storage
- User can reset all data from the Config tab.
- This clears localStorage, IndexedDB, and FileSystem storage.
- All data is local; nothing is stored on a central server.


---

