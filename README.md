
A p2p news app that uses the hypercore/hyperswarm stack to provide independent, no limit communication.

# Dev Diray
You can check out the dev-diary [here](https://hackmd.io/@mERxC4akTfWgpejBs9V3VQ/Hk-gF47-lg)
# Usage
Clone the repository:
```git clone https://github.com/trulynotafan/p2p-news-app```

## Install bare

```npm i -g bare```

## Run relay 


e.g: `npm run relay`                                                  
```
> p2p-news-app@0.0.1 relay
> node src/node_modules/relay/index.js

Relay running on ws://localhost:8080

```


## Run web peer

e.g: `npm run build && npm run web`   

```
[0000] info  Server running at http://192.168.1.10:9966/ (connect)
[0000] info  LiveReload running
[0003] 2752ms     2.3MB (browserify)

```
when two or more peers connect they will send each other the core-key and start core replication 


## Run native peer

e.g: `npx native-peer --name somename`   

```
 npx native-peer --name afaan                                       [15:56:26]
[peer-afaan] start
[peer-afaan] { peerkey: '6e2b26fabdf50698182e2339925e696e1e6166980fa0bc6ad4103eeb7a555292' }
[peer-afaan] ✅ Successfully created a new core with the key
[peer-afaan] { corekey: '748b6027047f111ff07d403a0746e43f34d00df061564e4ad8f6af74d897b222' }
[peer-afaan] Joining swarm
Swarm Joined, looking for peers
Native peer CLI started successfully.


```
Native peer will also join the same topic and connect to other browser/native peers.



More stuff will be added soon :)



