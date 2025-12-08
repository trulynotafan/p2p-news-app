console.log('p2p news app')
const news = require('news')


const customVault = {

    init_blog: async ({ username }) => {
        console.log('[customVault] init_blog:', username)
    },
    get_peer_blogs: async () => {
        console.log('[customVault] get_peer_blogs')
        return new Map()
    },
    get_my_posts: async () => {
        console.log('[customVault] get_my_posts')
        return []
    },
    get_profile: async (key) => {
        console.log('[customVault] get_profile:', key)
        return null
    },
    on_update: (callback) => {
        console.log('[customVault] on_update registered')
    }
}

init().catch(console.error)

async function init() {
    const app = await news({ sid: 0, vault: customVault })
    document.body.append(app)
}