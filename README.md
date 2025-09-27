
A p2p news app that uses the hypercore/hyperswarm stack to provide independent, no limit communication.

# Dev Diray
You can check out the dev-diary [here](https://hackmd.io/@mERxC4akTfWgpejBs9V3VQ/Hk-gF47-lg)

Also I have made a demo video which you guys can check that essentially explains this stack and app.
[Video](https://www.youtube.com/watch?v=79pv95Yk8qE)


# Usage

For Web peers just go to my deployed [github_page](https://trulynotafan.github.io/p2p-news-app/) and the hosted relay would work and let you join.

But if you want to try it manually:


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
Now open the webpage, input your username to join the topic, have your friends join aswell and when two peers connect, you can subsribe to each other and exchange blogs, fully decentralized. 

**Screenshot**

<img width="623" height="316" alt="image" src="https://github.com/user-attachments/assets/daffc03b-a036-4beb-a3db-6586b151bef2" />



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
The native peer will also join the same topic, and you will see diffrent option to subsribe to other online peers (web or CLI) and append data or replicate.

**Screenshot**

<img width="322" height="151" alt="image" src="https://github.com/user-attachments/assets/ab4b0ce6-f41f-47e2-b63c-59f806552650" />

If you want to see the flow of the code and how everything was made step by step check out the dev diary and for quick go through, check [code_explanation](https://github.com/trulynotafan/p2p-news-app/blob/main/docs/code_explanation.md)


If you want to learn or collab.. Please dm me on discord. my username is `trulynotafan`


