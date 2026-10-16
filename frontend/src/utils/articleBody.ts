type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }

const BULLET = /^-\s+/
const NUMBERED = /^\d+\.\s+/

/**
 * Turns the plain-text article body into paragraphs and lists. Blank lines separate blocks;
 * lines starting with "- " or "1. " become list items. Everything is rendered as React text
 * nodes, so HTML or scripts typed into an article are shown as text and never executed.
 */
export function parseArticleBody(body: string): Block[] {
  const blocks: Block[] = []
  for (const line of body.split(/\r?\n/).map((item) => item.trim())) {
    if (!line) continue
    const ordered = NUMBERED.test(line)
    if (ordered || BULLET.test(line)) {
      const text = line.replace(ordered ? NUMBERED : BULLET, '')
      const last = blocks.at(-1)
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(text)
      else blocks.push({ kind: 'list', ordered, items: [text] })
    } else {
      blocks.push({ kind: 'paragraph', text: line })
    }
  }
  return blocks
}
