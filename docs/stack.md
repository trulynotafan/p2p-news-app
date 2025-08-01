# P2P-News-App Stack Explained

Welcome, This document explains the cool building blocks that power our p2p-news-app. We'll go through them one by one, making it super simple to understand.

---

## Core Stack Components

These are the main tools we use to make the app work without any central servers.

### 1. Bare Runtime

Imagine you have a super-fast racing car. You take out everything you don't need like the radio and back seats to make it lighter and faster. **Bare** is like that for computer programs. It's a minimal environment, like a stripped-down Node.js, that gives us just enough tools (like handling files and network connections) to run our P2P app. This makes our app lightweight and speedy, perfect for running on different devices, even phones. It also works on android! 

* [Bare GitHub](https://github.com/holepunchto/bare)
* [Bare Docs](https://bare.pears.com)


### 2. Corestore + Hypercore

Think of a **Hypercore** as a notebook where you can only add new pages at the end; you can't go back and change old ones. This makes it a secure, append-only log. Every user in our app gets their own magic notebook to write their blog posts.

A **Corestore** is like a big library that holds all these notebooks (Hypercores). When you want to read someone's blog, the library gives you a read-only copy of their notebook. Because it's append-only and verified, you know for sure that the content is original and hasn't been tampered with.

* [Hypercore Docs](https://docs.pears.com/building-blocks/hypercore)

**Example Usage:**

```javascript
const Hypercore = require('hypercore');
const core = new Hypercore('./directory');
await core.append(Buffer.from('I am a block of data'));
const block = await core.get(0);
```

**Replication Example:**

```javascript
const swarm = new Hyperswarm();
swarm.on('connection', conn => {
  core.replicate(conn);
});
```

### 3. Hyperswarm

How do you find your friends in a big club? You might all agree to meet at the big round table? **Hyperswarm** is like that meeting spot for our app. When you open the app, you join a "topic" (our virtual table). Hyperswarm then uses some P2P magic (a Distributed Hash Table, or DHT) to help you find and connect directly to other users who are in the same topic. There's no central operator telling everyone where to go; it's just peers finding peers.

* [Hyperswarm Docs](https://docs.pears.com/building-blocks/hyperswarm)

**Example Usage:**

```javascript
const Hyperswarm = require('hyperswarm');
const swarm = new Hyperswarm();
swarm.join('some-topic', (err, discovery) => {
  if (err) throw err;
  console.log('joined topic');
  swarm.on('connection', (socket, info) => {
    console.log('connection from', info.host);
    // Handle socket
  });
});
```

### 4. Hyperdrive

A **Hyperdrive** is like a shared folder that everyone can access and that updates in real-time. We use it to store all the files for a user's blog—the posts, images, and everything else. It’s built on top of Hypercore, so it’s secure and decentralized. When you subscribe to someone's blog, you are essentially syncing their Hyperdrive to your device.

* [hyperdrive GitHub](https://github.com/holepunchto/hyperdrive)

**Example Usage:**

```javascript
const Hyperdrive = require('hyperdrive');
const store = new Corestore('./some-dir');
const drive = new Hyperdrive(store);
await drive.ready();
await drive.put('/example.txt', Buffer.from('Hello, World!'));
const data = await drive.get('/example.txt');
```

**Replication Example:**

```javascript
const swarm = new Hyperswarm();
const done = drive.findingPeers();
swarm.on('connection', (socket) => drive.replicate(socket));
swarm.join(drive.discoveryKey);
swarm.flush().then(done, done);
```

### 5. Autobase

Imagine a group of people writing a story together. Each person has their own notebook (a Hypercore) where they write their parts. **Autobase** is like the magical editor that takes everyone's notebooks and puts all the parts together into a single, shared story (a "view").

* **Ordering**: Autobase figures out the correct order of everyone's contributions by looking at what was written before. It creates a timeline that everyone can agree on, even if some people's updates arrive late. This order might get adjusted as new updates come in, but it will eventually become consistent for everyone.
* **Views**: The final, combined story is the "view". It’s the result of applying everyone's ordered inputs. We use a special `apply` function to add each new piece to the view, building the complete picture of the system state. This view could be a chat history, a list of blog posts, or anything we want to build together.

* [Autobase GitHub](https://github.com/holepunchto/autobase)
* [Great explanation and links to learn more](https://hackmd.io/@serapath/rkKXTd1mxe)

**Example Usage:**

```javascript
const Corestore = require('corestore');
const Autobase = require('autobase');
const store = new Corestore('./some-dir');
const local = new Autobase(store, remote.key, { apply, open });
await local.ready();
await local.append('local 0');
await local.update();
for (let i = 0; i < local.view.length; i++) {
  console.log(await local.view.get(i));
}
```

### 6. Autodrive

It's a merge of hyperdrive and autobase. It's like a shared folder that multiple people can access and that updates in real-time. We can use it to have two people write to one hyperdrive at the same time, and they will both see the same view of the data. Can be very useful if one person has different devices. 

* [Autodrive (our implementation)](https://github.com/trulynotafan/p2p-news-app/tree/main/src/node_modules/autodrive)
* [Autodrive by OzymandiasTheGreat](https://github.com/OzymandiasTheGreat/autodrive/tree/main)

**Example Usage:**

```javascript
import Autodrive from "autodrive";
import b4a from "b4a";
import Corestore from "corestore";
const driveA = new Autodrive(new Corestore("./storageA"));
await driveA.ready();
const driveB = new Autodrive(new Corestore("./storageB"), driveA.key);
await driveB.ready();
await driveA.put("/example.txt", b4a.from("Hello, World!"));
const data = await driveB.get("/example.txt");
```

### 7. Protomux

When you and a friend connect, you need a way to have different conversations at the same time without getting them mixed up. **Protomux** lets us do that over a single connection. It helps us create different "channels" for sending specific types of messages. For example, we can have one channel for sending identity information and another for exchanging the keys to our blog feeds. It keeps our communication organized.

* [Protomux GitHub](https://github.com/holepunchto/protomux)

**Example Usage:**

```javascript
const Protomux = require('protomux');
const c = require('compact-encoding');
const mux = new Protomux(aStreamThatFrames);
const cool = mux.createChannel({
  protocol: 'cool-protocol',
  id: Buffer.from('optional binary id'),
  onopen () {
    console.log('the other side opened this protocol!');
  },
  onclose () {
    console.log('either side closed the protocol');
  }
});
const one = cool.addMessage({
  encoding: c.string,
  onmessage (m) {
    console.log('recv message (1)', m);
  }
});
cool.open();
one.send('a string');
```

### 8. Hyperswarm Secret Stream

When you're with your friends but you want to tell a secret to only one friend.. Well you can do that with Hyperswarm-secretstream. It establishes a secure connetion between peers and they can send data that no one else can decrypt.

* [Secret Stream GitHub](https://github.com/holepunchto/hyperswarm-secret-stream)

**Example Usage:**

```javascript
const SecretStream = require('@hyperswarm/secret-stream');
const a = new SecretStream(true, tcpClientStream);
const b = new SecretStream(false, tcpServerStream);
a.write(Buffer.from('hello encrypted!'));
b.on('data', function (data) {
  console.log(data); // <Buffer hello encrypted!>
});
```

---

## Connecting to Browsers

Getting P2P to work in a web browser is tricky because browsers have security restrictions. These tools help us bridge the gap.

### 1. Hyperswarm DHT Relay

A web browser can't directly talk to the main P2P network (the Hyperswarm DHT) like our command-line app can. The **DHT Relay** acts as a helpful translator. Browser peers connect to this relay, and the relay talks to the P2P network on their behalf, passing messages back and forth. This allows browser users to find and connect with other peers.

* [Hyperswarm DHT Relay GitHub](https://github.com/holepunchto/hyperswarm-dht-relay)

**Example Usage:**

**Relaying side:**

```javascript
import DHT from 'hyperdht';
import { relay } from '@hyperswarm/dht-relay';
relay(new DHT(), stream);
```

**Relayed side:**

```javascript
import DHT from '@hyperswarm/dht-relay';
const dht = new DHT(stream);
```

### 2. Hyper WebRTC

While the relay helps browser peers find each other, their data still has to pass through it. To make a true peer-to-peer connection, we use **Hyper WebRTC**. Once two browser peers discover each other via the relay, they can use WebRTC to create a direct, private link between them. This way, they can exchange blog posts and other data directly, without relying on the relay server. Meaning less traffic on relay!

* [Hyper WebRTC GitHub](https://github.com/LuKks/hyper-webrtc)

**Example Usage:**

```javascript
swarm.on('connection', function (relay) {
  const stream = HyperWebRTC.from(relay);
  core.replicate(stream);
});
```

---

## Helper Modules

These are smaller, but very important, tools that help with security, data handling, and other key functions.

### 1. bip39-mnemonic

Remember those secret recovery phrases you get for a crypto wallet (like "apple banana car tree...")? **bip39-mnemonic** is a tool that creates and manages those. It lets us turn a complex secret key into a list of simple words, making it easier for users to back up and restore their identity securely.

* [bip39 GitHub](https://github.com/holepunchto/bip39-mnemonic)

**Example Usage:**

```javascript
const { generateMnemonic, mnemonicToSeed } = require('bip39-mnemonic');
const mnemonic = generateMnemonic();
const seed = mnemonicToSeed(mnemonic);
```

### 2. keet-identity-key

This tool helps you use the same identity across multiple devices, like your phone and your laptop. Using a secret phrase (from bip39), **keet-identity-key** can create secure keys and generate a proof that a new device belongs to you. This way, you can "pair" your devices so they all share the same blog and subscriptions.

* [keet-identity-key GitHub](https://github.com/holepunchto/keet-identity-key)

**Example Usage:**

```javascript
const IdentityKey = require('keet-identity-key');
const mnemonic = IdentityKey.generateMnemonic();
const id = await IdentityKey.from({ mnemonic });
const proof0 = id.bootstrap(mainDevice.publicKey);
const proof = IdentityKey.attest(auxillaryDevice.publicKey, mainDevice, proof0);
const info = IdentityKey.verify(proof);
if (info === null) {
  // verification failed
} else {
  console.log(b4a.equals(info.identityPublicKey, id.identityPublicKey)); // true
  console.log(b4a.equals(info.publicKey, auxillaryDevice.publicKey)); // true
}
```

### 3. b4a (Buffer for Array)

Computers handle data in a format called "buffers." Node.js and web browsers handle buffers slightly differently. **b4a** is a small library that smooths out these differences, so we can write code that works with buffer and typed arrays everywhere without worrying about what environment it's running in.

* [b4a GitHub](https://github.com/holepunchto/b4a)

**Example Usage:**

```javascript
const b4a = require('b4a');
const buffer = b4a.from('Hello, World!');
console.log(b4a.toString(buffer)); // Hello, World!
```

### 4. compact-encoding

When sending data over a network, you want it to be as small and fast as possible. **compact-encoding** is a library that helps us encode and decode our data into a very compact binary format. This is especially useful for the messages we send with Protomux, as it keeps our communication efficient.

* [Compact Encoding GitHub](https://github.com/holepunchto/compact-encoding)

**Example Usage:**

```javascript
const cenc = require('compact-encoding');
const state = cenc.state();
cenc.uint.preencode(state, 42);
cenc.string.preencode(state, 'hi');
state.buffer = Buffer.allocUnsafe(state.end);
cenc.uint.encode(state, 42);
cenc.string.encode(state, 'hi');
state.start = 0;
console.log(cenc.uint.decode(state)); // 42
console.log(cenc.string.decode(state)); // 'hi'
```

### 5. sodium-universal

Security is super important. **Sodium** is a famous, library for all things cryptography, like encrypting messages, creating digital signatures, and hashing data. We use `sodium-universal`, a version that works the same way in both Node.js and web browsers, so our security is consistent everywhere.

* [sodium-universal GitHub](https://github.com/holepunchto/sodium-universal)

**Example Usage:**

```javascript
var sodium = require('sodium-universal');
var rnd = Buffer.allocUnsafe(12);
sodium.randombytes_buf(rnd);
console.log(rnd.toString('hex'));
```
