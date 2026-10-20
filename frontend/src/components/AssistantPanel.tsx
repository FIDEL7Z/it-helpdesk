import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { askAssistant, type AssistantReply } from '../services/assistant'
import { ApiError } from '../services/api'
import type { UserRole } from '../services/auth'
import { getErrorMessage } from '../utils/errors'

const SUGGESTIONS: Record<UserRole, string[]> = {
  solicitante: ['Meu teclado parou de funcionar, o que eu faço?', 'Como está o meu último pedido?', 'A internet está com problema?'],
  ti: ['Quantos teclados temos disponíveis?', 'Quais chamados de teclado estão abertos?', 'Como orientar alguém com problema de acesso?'],
  gestor: ['Qual o consumo de materiais por setor neste mês?', 'Como está a carga da equipe?', 'Como está a qualidade do atendimento neste mês?'],
}

const KIND_LABELS: Record<AssistantReply['sources'][number]['kind'], string> = {
  article: 'Artigo', incident: 'Problema conhecido', ticket: 'Chamado', stock: 'Estoque', metric: 'Indicador', guide: 'Guia do sistema',
}

type Message = { id: number; role: 'person'; text: string } | { id: number; role: 'assistant'; reply: AssistantReply } | { id: number; role: 'error'; text: string }

/**
 * Advisory chat available on every page. The conversation lives only in this page's memory: it is
 * not stored. The assistant never changes tickets or stock; it points to the page where to act.
 */
export function AssistantPanel() {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const nextId = useRef(1)
  const titleId = useId()
  const panelId = useId()

  // Focus the question when the panel opens and again when an answer arrives (the field is
  // disabled while waiting, so it cannot take focus before that).
  useEffect(() => {
    if (open && !busy) inputRef.current?.focus()
  }, [open, busy])

  // Escape closes the panel wherever the focus is while it is open.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        launcherRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' })
  }, [messages])

  if (!user) return null
  const lastMode = [...messages].reverse().find((message): message is Extract<Message, { role: 'assistant' }> => message.role === 'assistant')?.reply.mode

  function close() {
    setOpen(false)
    launcherRef.current?.focus()
  }

  async function send(text: string) {
    const trimmed = text.trim()
    if (trimmed.length < 3 || busy) return
    setMessages((list) => [...list, { id: nextId.current++, role: 'person', text: trimmed }])
    setQuestion('')
    setBusy(true)
    try {
      const { reply } = await askAssistant(trimmed)
      setMessages((list) => [...list, { id: nextId.current++, role: 'assistant', reply }])
    } catch (error) {
      const text = error instanceof ApiError && error.status === 429
        ? 'Muitas perguntas em pouco tempo. Aguarde alguns minutos e tente de novo.'
        : getErrorMessage(error)
      setMessages((list) => [...list, { id: nextId.current++, role: 'error', text }])
    } finally {
      setBusy(false)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void send(question)
  }

  // Enter sends; Shift+Enter breaks the line.
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(question)
    }
  }

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        className="assistant-launcher"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
        </svg>
        <span>Assistente</span>
      </button>

      {open && (
        <section id={panelId} className="assistant-panel" role="dialog" aria-modal="false" aria-labelledby={titleId}>
          <header className="assistant-panel__header">
            <div>
              <h2 id={titleId} className="assistant-panel__title">Assistente</h2>
              <p className="assistant-panel__subtitle">
                {lastMode === 'ai' ? <span className="badge badge--status-resolvido">IA</span> : lastMode === 'demo' ? <span className="badge badge--status-em_andamento">Modo demonstrativo</span> : null}
                {' '}Responde com o que você já pode ver no sistema. Não altera chamados nem estoque.
              </p>
            </div>
            <button type="button" className="button button--ghost button--small" onClick={close} aria-label="Fechar o assistente">Fechar</button>
          </header>

          <ol ref={listRef} className="assistant-panel__messages" aria-live="polite">
            {messages.length === 0 && (
              <li className="assistant-panel__empty">
                <p>Experimente perguntar:</p>
                <div className="assistant-panel__suggestions">
                  {SUGGESTIONS[user.role].map((text) => (
                    <button key={text} type="button" className="choice-pill assistant-panel__suggestion" disabled={busy} onClick={() => void send(text)}>{text}</button>
                  ))}
                </div>
              </li>
            )}
            {messages.map((message) => (
              <li key={message.id} className={`assistant-message assistant-message--${message.role}`}>
                {message.role === 'person' && <p>{message.text}</p>}
                {message.role === 'error' && <p role="alert">{message.text}</p>}
                {message.role === 'assistant' && (
                  <>
                    {/* Every reply says where it came from: a demonstration never passes for an AI answer. */}
                    <p className={`assistant-message__origin assistant-message__origin--${message.reply.mode}`}>
                      {message.reply.mode === 'ai' ? `Resposta da IA${message.reply.model ? ` · ${message.reply.model.split('/').pop()}` : ''}` : 'Modo demonstrativo · sem IA'}
                    </p>
                    {message.reply.notice && <p className="assistant-message__notice">{message.reply.notice}</p>}
                    <p className="assistant-message__answer">{message.reply.answer}</p>
                    {message.reply.sources.length > 0 && (
                      <ul className="assistant-message__sources" aria-label="Fontes da resposta">
                        {message.reply.sources.map((source) => (
                          <li key={source.id}>
                            <span className="assistant-message__source-id">[{source.id}]</span>{' '}
                            {source.link ? <Link to={source.link} onClick={close}>{source.title}</Link> : source.title}
                            <span className="text-muted"> · {KIND_LABELS[source.kind]}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </li>
            ))}
            {busy && <li className="assistant-message assistant-message--assistant" role="status"><span className="spinner spinner--small" aria-hidden="true" /> Procurando...</li>}
          </ol>

          <form className="assistant-panel__form" onSubmit={handleSubmit}>
            <label htmlFor={`${panelId}-question`} className="sr-only">Sua pergunta</label>
            <textarea
              id={`${panelId}-question`}
              ref={inputRef}
              className="field__input assistant-panel__input"
              rows={2}
              maxLength={500}
              placeholder="Escreva sua pergunta"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={busy}
            />
            <button type="submit" className="button button--primary" disabled={busy || question.trim().length < 3}>Perguntar</button>
          </form>
        </section>
      )}
    </>
  )
}
