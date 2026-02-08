module.exports = function WritePage ({ onPublish }) {
  const container = document.createElement('div')
  container.className = 'write-page-container'

  const header = document.createElement('div')
  header.className = 'section-header'

  const h1 = document.createElement('h1')
  h1.textContent = 'Write a Story'

  const p = document.createElement('p')
  p.textContent = 'Share your thoughts with the network'

  header.appendChild(h1)
  header.appendChild(p)
  container.appendChild(header)

  const card = document.createElement('div')
  card.className = 'card'

  const spaceY = document.createElement('div')
  spaceY.className = 'space-y-8'

  const group1 = document.createElement('div')
  group1.className = 'input-group'

  const label1 = document.createElement('label')
  label1.textContent = 'Publishing To'

  const blogSelect = document.createElement('select')
  blogSelect.className = 'blog-select'
  const blogs = ['Main Blog', 'Tech Weekly', 'Cooking Adventures', 'Travel Logs']
  blogs.forEach(blog => {
    const opt = document.createElement('option')
    opt.value = blog
    opt.textContent = blog
    if (blog === 'Main Blog') opt.selected = true
    blogSelect.appendChild(opt)
  })

  group1.appendChild(label1)
  group1.appendChild(blogSelect)
  spaceY.appendChild(group1)

  const group2 = document.createElement('div')
  group2.className = 'input-group'

  const label2 = document.createElement('label')
  label2.textContent = 'Story Title'

  const titleInput = document.createElement('input')
  titleInput.type = 'text'
  titleInput.className = 'input-title'
  titleInput.placeholder = 'Give your story a captivating title...'

  group2.appendChild(label2)
  group2.appendChild(titleInput)
  spaceY.appendChild(group2)

  const divider = document.createElement('div')
  divider.className = 'divider'
  spaceY.appendChild(divider)

  const group3 = document.createElement('div')
  group3.className = 'input-group'

  const label3 = document.createElement('label')
  label3.textContent = 'Your Story'

  const contentArea = document.createElement('textarea')
  contentArea.className = 'input-content'
  contentArea.placeholder = 'Write your story here. Share your thoughts, experiences, and insights...'

  const wordCountDiv = document.createElement('div')
  wordCountDiv.className = 'word-count'

  const wordCountSpan = document.createElement('span')
  wordCountSpan.textContent = '0 words'

  const readTimeSpan = document.createElement('span')
  readTimeSpan.textContent = '~0 min read'

  wordCountDiv.appendChild(wordCountSpan)
  wordCountDiv.appendChild(readTimeSpan)

  group3.appendChild(label3)
  group3.appendChild(contentArea)
  group3.appendChild(wordCountDiv)
  spaceY.appendChild(group3)

  const actions = document.createElement('div')
  actions.className = 'actions'

  const publishBtn = document.createElement('button')
  publishBtn.className = 'btn-publish'
  publishBtn.textContent = 'Publish Story'

  const actionText = document.createElement('p')
  actionText.className = 'action-text'
  actionText.textContent = 'Your story will be stored locally and synced with your network'

  actions.appendChild(publishBtn)
  actions.appendChild(actionText)
  spaceY.appendChild(actions)

  card.appendChild(spaceY)
  container.appendChild(card)

  const tips = document.createElement('div')
  tips.className = 'tips'

  const tipData = [
    { title: 'Be Authentic', text: 'Write what you genuinely think and feel, not what algorithms demand' },
    { title: 'Tell a Story', text: 'Use examples and narratives to engage readers and make ideas stick' },
    { title: 'Add Value', text: 'Help readers learn something new or see the world differently' }
  ]

  tipData.forEach(t => {
    const tipDiv = document.createElement('div')
    tipDiv.className = 'tip'
    const h3 = document.createElement('h3')
    h3.textContent = t.title
    const p = document.createElement('p')
    p.textContent = t.text
    tipDiv.appendChild(h3)
    tipDiv.appendChild(p)
    tips.appendChild(tipDiv)
  })

  container.appendChild(tips)

  const state = {
    blog: 'Main Blog',
    title: '',
    content: ''
  }

  blogSelect.addEventListener('change', (e) => { state.blog = e.target.value })

  titleInput.addEventListener('input', (e) => { state.title = e.target.value })

  contentArea.addEventListener('input', (e) => {
    state.content = e.target.value
    const words = e.target.value.trim() === '' ? 0 : e.target.value.trim().split(/\s+/).length
    wordCountSpan.textContent = `${words} words`
    readTimeSpan.textContent = `~${Math.ceil(words / 200)} min read`
  })

  publishBtn.addEventListener('click', () => {
    if (!state.title || !state.content) {
      alert('Please fill in both title and content.')
      return
    }

    if (onPublish) {
      onPublish({
        title: state.title,
        content: state.content,
        blog: state.blog
      })
    }
  })

  return container
}
