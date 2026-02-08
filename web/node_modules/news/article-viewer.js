module.exports = function ArticleViewer (data) {
  const article = document.createElement('article')
  article.classList.add('article-container')

  const header = document.createElement('header')
  header.classList.add('article-header')

  const h1 = document.createElement('h1')
  h1.classList.add('article-title')
  h1.textContent = data.title

  const meta = document.createElement('div')
  meta.classList.add('article-meta')

  const bySpan = document.createElement('span')
  bySpan.textContent = 'By '
  const authorStrong = document.createElement('strong')
  authorStrong.textContent = data.author
  bySpan.appendChild(authorStrong)

  const separator = document.createTextNode(' • ')

  const dateSpan = document.createElement('span')
  dateSpan.textContent = data.date

  meta.appendChild(bySpan)
  meta.appendChild(separator)
  meta.appendChild(dateSpan)

  header.appendChild(h1)
  header.appendChild(meta)

  const body = document.createElement('div')
  body.classList.add('article-body')

  // Basic Markdown Rendering
  const htmlFromMarkdown = data.content
    .split('\n\n')
    .map(block => {
      block = block.trim()
      if (!block) return ''

      // Headers
      if (block.startsWith('# ')) return `<h1>${block.slice(2)}</h1>`
      if (block.startsWith('## ')) return `<h2>${block.slice(3)}</h2>`
      if (block.startsWith('### ')) return `<h3>${block.slice(4)}</h3>`

      // Lists
      if (block.startsWith('- ')) {
        const items = block.split('\n').map(line => `<li>${line.replace(/^- /, '')}</li>`).join('')
        return `<ul>${items}</ul>`
      }

      // Paragraph handling with inline styles
      let p = block

      // Bold
      p = p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      // Italic
      p = p.replace(/\*(.*?)\*/g, '<em>$1</em>')
      // Links
      p = p.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>')

      return `<p>${p}</p>`
    })
    .join('')

  body.innerHTML = htmlFromMarkdown

  article.appendChild(header)
  article.appendChild(body)

  return article
}
