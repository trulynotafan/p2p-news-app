module.exports = function parseContent (raw) {
  if (!raw) return null

  try {
    const data = JSON.parse(raw)
    if (data && typeof data === 'object') return data
  } catch (e) { }

  const fmRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/
  const match = raw.match(fmRegex)

  if (match) {
    const metadataStr = match[1]
    const content = match[2]
    const metadata = {}

    metadataStr.split('\n').forEach(line => {
      const colonIndex = line.indexOf(':')
      if (colonIndex !== -1) {
        const key = line.slice(0, colonIndex).trim()
        let value = line.slice(colonIndex + 1).trim()

        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }

        // Handle arrays (simple comma separated)
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map(s => {
            s = s.trim()
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
              return s.slice(1, -1)
            }
            return s
          })
        }

        metadata[key] = value
      }
    })

    return { ...metadata, content: content.trim() }
  }

  return { content: raw }
}
