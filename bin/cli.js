#!/usr/bin/env bare

const bare_peer = require('../src/node_modules/bare-peer/index.js')
const process = require('bare-process')
const b4a = require('b4a')

function parse_cli_args(args) {
  const parsed = {}
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') {
      parsed.name = args[i + 1]
      if (!parsed.name || parsed.name.startsWith('--')) {
        console.error("--name requires a name as an argument")
        process.exit(1)
      }
      i++
    }
  }
  
  return parsed
}

function validate_cli_args(opts) {
  if (!opts.name) {
    const hostname = process.env.HOSTNAME || 'unknown'
    const timestamp = Date.now().toString().slice(-4)
    opts.name = `${hostname}-${timestamp}`
    console.log(`Generated device name: ${opts.name}`)
  }
  return opts
}

async function show_menu() {
  console.log('\n=== P2P Blog Menu ===')
  console.log('1. Create new blog post')
  console.log('2. View all posts')
  console.log('3. View discovered peers')
  console.log('4. subscribe to peer')
  console.log('5. View subscribed blogs')
  console.log('6. exit')
  console.log('\nEnter your choice (1-6): ')
}

async function show_discovered_peers(peer) {
  const { blog_helper, discovered_peers } = peer
  const peer_list = []
  let i = 1

  console.log('\n=== Available Peers ===')
  
  for (const [peer_id, peer_info] of discovered_peers) {
    if (peer_info.initialized && peer_info.drive_key && peer_info.username) {
      const subscribed_blogs = blog_helper.get_peer_blogs()
      const hex_key = Array.from(blog_helper.get_discovered_blogs().keys())
        .find(key => {
          const blog = blog_helper.get_discovered_blogs().get(key)
          return blog && blog.username === peer_info.username
        })
      
      const is_subscribed = hex_key ? subscribed_blogs.has(hex_key) : false
      
      console.log(`${i}. ${peer_info.username} (${peer_info.mode})${is_subscribed ? ' [Subscribed]' : ''}`)
      console.log(`   Blog: "${peer_info.blog_title}"`)
      peer_list.push({ 
        peer_id, 
        username: peer_info.username, 
        title: peer_info.blog_title,
        is_subscribed 
      })
      i++
    }
  }
  
  if (peer_list.length === 0) {
    console.log('No peers with blogs available')
    console.log('\nDiscovered peers (may not have blogs yet):')
    for (const [peer_id, peer_info] of discovered_peers) {
      console.log(`- ${peer_info.username} (${peer_info.mode}) ${peer_info.initialized ? '[Has Blog]' : '[No Blog Yet]'}`)
    }
    return null
  }
  
  return peer_list
}

async function handle_user_input(input, peer) {
  const { blog_helper, subscribe_to_peer } = peer
  
  switch(input.trim()) {
    case '1':
      console.log('\n=== Create New Post ===')
      console.log('Enter title:')
      const title = await read_line()
      console.log('Enter content:')
      const content = await read_line()
      
      await blog_helper.create_post(title, content)
      console.log('\nPost created')
      break

    case '2':
      console.log('\n=== All Posts ===')
      const core = peer.blog_core
      
      if (core.length <= 1) {
        console.log('No posts yet')
        break
      }

      for (let i = 1; i < core.length; i++) {
        const entry = JSON.parse(b4a.toString(await core.get(i)))
        console.log(`\n${entry.title}`)
        console.log(`Type: ${entry.type}`)
        if (entry.content) console.log(entry.content)
        console.log(`Posted: ${new Date(entry.created).toLocaleString()}`)
        console.log('---')
      }
      break

    case '3':
      await show_discovered_peers(peer)
      break

    case '4':
      console.log('\n=== Subscribe to Peer ===')
      const peers = await show_discovered_peers(peer)
      
      if (!peers) {
        console.log('\nWaiting for peers to initialize their blogs.')
        break
      }
      
      console.log('\nEnter peer number (0 to cancel):')
      const choice = await read_line()
      const num = parseInt(choice.trim())
      
      if (num === 0 || num < 1 || num > peers.length) {
        console.log('Invalid choice')
        break
      }
      
      const peer_info = peers[num - 1]
      
      if (peer_info.is_subscribed) {
        console.log(`Already subscribed to ${peer_info.username}`)
        break
      }
      
      console.log(`\nSubscribing to ${peer_info.username}...`)
      console.log(`Blog: "${peer_info.title}"`)
      
      const success = await subscribe_to_peer(peer_info.peer_id)
      
      if (success) {
        console.log(`\nSuccessfully subscribed to ${peer_info.username}!`)
        
        const subscribed_blogs = blog_helper.get_peer_blogs()
        for (const [key, blog] of subscribed_blogs) {
          if (blog.username === peer_info.username) {
            console.log(`Available posts: ${blog.posts?.length || 0}`)
            if (blog.posts && blog.posts.length > 0) {
              console.log('Recent posts:')
              blog.posts.slice(-3).forEach(post => {
                console.log(`- ${post.title} (${new Date(post.created).toLocaleString()})`)
              })
            }
            break
          }
        }
      } else {
        console.log(`\nFailed to subscribe to ${peer_info.username}`)
      }
      break

    case '5':
      console.log('\n=== Subscribed Blogs ==')
      const subscribed = blog_helper.get_peer_blogs()
      
      if (subscribed.size === 0) {
        console.log('Not subscribed to any blogs')
        break
      }
      
      for (const [key, peer_blog] of subscribed) {
        console.log(`\n${peer_blog.username}'s Blog`)
        console.log(`   Mode: ${peer_blog.mode || 'unknown'}`)
        console.log(`   Posts: ${peer_blog.posts?.length || 0}`)
        
        if (peer_blog.posts && peer_blog.posts.length > 0) {
          console.log('   Recent posts:')
          peer_blog.posts.slice(-3).forEach(post => {
            console.log(`   - ${post.title} (${new Date(post.created).toLocaleString()})`)
          })
        }
      }
      break

    case '6':
      console.log('\nGoodbye!')
      process.exit(0)
      break

    default:
      console.log('\nInvalid choice')
  }
}

function read_line() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (chunk) => {
      chunks.push(chunk)
      if (chunk.includes('\n')) {
        process.stdin.removeAllListeners('data')
        resolve(Buffer.concat(chunks).toString().trim())
      }
    })
  })
}

async function start_native(peer) {
  console.log('\nStarting native peer')
  console.log('Discovering peers...')
  
  while (true) {
    await show_menu()
    const choice = await read_line()
    await handle_user_input(choice, peer)
  }
}

const cli_args = process.argv.slice(2)
const parsed_args = parse_cli_args(cli_args)
const validated_args = validate_cli_args(parsed_args)

console.log('Starting peer:', validated_args.name)

bare_peer.start(validated_args)
  .then(async (peer) => {
    await start_native(peer)
  })
  .catch(err => {
    console.error('Failed to start peer:', err)
    process.exit(1)
  })