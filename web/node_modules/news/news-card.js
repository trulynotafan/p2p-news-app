module.exports = function NewsCard (data, isMyStories) {
  const card = document.createElement('div')
  card.className = 'news-card'

  const avatar = document.createElement('div')
  avatar.className = 'news-avatar'
  avatar.textContent = data.title ? data.title.charAt(0) : '?'
  if (data.color) avatar.style.setProperty('--avatar-bg', data.color)
  else avatar.style.setProperty('--avatar-bg', '#e5e7eb')

  const content = document.createElement('div')
  content.className = 'news-content'

  if (isMyStories) {
    const metaTop = document.createElement('div')
    metaTop.className = 'news-meta-top'
    const authorSpan = document.createElement('span')
    authorSpan.className = 'news-author'
    authorSpan.textContent = data.author

    const sep = document.createElement('span')
    sep.className = 'news-separator'
    sep.textContent = '•'

    const dateSpan = document.createElement('span')
    dateSpan.className = 'news-date-text'
    dateSpan.textContent = data.date

    metaTop.appendChild(authorSpan)
    metaTop.appendChild(sep)
    metaTop.appendChild(dateSpan)
    content.appendChild(metaTop)
  }

  const title = document.createElement('h3')
  title.className = 'news-title'
  title.textContent = data.title
  content.appendChild(title)

  const description = document.createElement('p')
  description.className = 'news-description'
  description.textContent = data.description || 'No description available.'
  content.appendChild(description)

  if (!isMyStories) {
    const metaBottom = document.createElement('div')
    metaBottom.className = 'news-meta-bottom'

    const authorSpan = document.createElement('span')
    authorSpan.className = 'news-author-muted'
    authorSpan.textContent = data.author

    const sep = document.createElement('span')
    sep.className = 'news-separator'
    sep.textContent = '•'

    const dateSpan = document.createElement('span')
    dateSpan.className = 'news-date-text'
    dateSpan.textContent = data.date

    metaBottom.appendChild(authorSpan)
    metaBottom.appendChild(sep)
    metaBottom.appendChild(dateSpan)

    if (data.tags && Array.isArray(data.tags)) {
      // To be safe and avoid innerHTML here too, let's do it properly
      data.tags.forEach(tag => {
        const tagSpan = document.createElement('span')
        tagSpan.className = 'news-tag-pill'
        tagSpan.textContent = tag
        metaBottom.appendChild(tagSpan)
      })
    }

    content.appendChild(metaBottom)
  }

  card.appendChild(avatar)
  card.appendChild(content)

  return card
}
