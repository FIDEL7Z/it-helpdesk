import { parseArticleBody } from '../utils/articleBody'

export function ArticleBody({ body }: { body: string }) {
  return (
    <div className="article-body">
      {parseArticleBody(body).map((block, index) => {
        if (block.kind === 'paragraph') return <p key={index}>{block.text}</p>
        const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)
        return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
      })}
    </div>
  )
}
