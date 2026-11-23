import * as chrono from 'chrono-node'

const actionPattern = /\b(follow\s?up|next\s+meeting|deadline|action|by\s+\w+|due\s+by)\b/i

export function extractActionSuggestions(content, referenceDate) {
  const lines = content
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->.*$/g, '').trim())
    .filter((line) => line.length >= 8 && actionPattern.test(line))
    .slice(0, 100)
  const seen = new Set()
  return lines.flatMap((line) => {
    const key = line.toLowerCase()
    if (seen.has(key)) return []
    seen.add(key)
    const parsed = chrono.parse(line, referenceDate, { forwardDate: true })[0]
    return [{ title: line.slice(0, 500), due_at: parsed?.start.date().toISOString() ?? null }]
  })
}
