/* global vault */
const news = require('news')

// Initialize with datashell vault/api
// The vault is passed globally by datashell loader or available via window/global
const app = news(vault)
document.body.append(app)
