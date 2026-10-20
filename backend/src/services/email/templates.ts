// Transactional e-mails in Brazilian Portuguese: responsive HTML (tables and inline styles, the way
// mail clients need it) plus plain text. They carry only what the requester already sees on the
// ticket page: no reasons or justifications written by the team, no internal notes, no other
// people's contact data, no tokens except the single-use confirmation link.

export type TicketMailKind = 'ticket_created' | 'ticket_started' | 'ticket_resolved' | 'ticket_reopened' | 'material_delivered';

export interface TicketMail {
  kind: TicketMailKind;
  recipientName: string;
  ticketId: string;
  ticketTitle: string;
  occurredAt: Date;
  /** ticket_started: who started the work (shown on the ticket page as "Atendido por"). */
  responsibleName?: string | null;
  /** material_delivered: lines like "1 × Teclado Logitech K120". */
  items?: string[];
}

export interface VerificationMail {
  recipientName: string;
  confirmUrl: string;
  expiresAt: Date;
  /** True when confirming a new address (the login e-mail changes after it). */
  isChange: boolean;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

interface Context {
  appUrl: string;
  timezone: string;
}

const COLORS = { nav: '#17324d', primary: '#067682', text: '#172b3a', muted: '#526477', border: '#dce4ea', page: '#f5f7fa', surface: '#ffffff' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** One line, no control characters: a ticket title cannot add mail headers. */
function headerSafe(value: string, max = 120): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The same short reference the queue board shows. */
export function ticketReference(ticketId: string): string {
  return `#${ticketId.slice(-6)}`;
}

function formatDateTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

const TICKET_COPY: Record<TicketMailKind, { subject: string; heading: string; body: (mail: TicketMail) => string[]; action: string }> = {
  ticket_created: {
    subject: 'Recebemos seu pedido',
    heading: 'Seu pedido foi registrado',
    body: () => ['A equipe de TI recebeu o pedido e vai analisá-lo. Você acompanha cada etapa pela página do pedido.'],
    action: 'Acompanhar o pedido',
  },
  ticket_started: {
    subject: 'Seu pedido está em atendimento',
    heading: 'O atendimento começou',
    body: (mail) => [mail.responsibleName ? `${mail.responsibleName} está cuidando do seu pedido.` : 'A equipe de TI começou a cuidar do seu pedido.'],
    action: 'Ver o pedido',
  },
  ticket_resolved: {
    subject: 'Seu pedido foi resolvido: confirme se deu certo',
    heading: 'A TI marcou seu pedido como resolvido',
    body: () => ['Abra o pedido e responda se o problema foi resolvido. Se ainda não funcionar, você pode avisar que o problema continua.'],
    action: 'Responder no pedido',
  },
  ticket_reopened: {
    subject: 'Seu pedido foi reaberto',
    heading: 'Seu pedido voltou para atendimento',
    body: () => ['A equipe de TI reabriu o pedido para continuar o atendimento.'],
    action: 'Ver o pedido',
  },
  material_delivered: {
    subject: 'Material entregue no seu pedido',
    heading: 'A TI registrou uma entrega no seu pedido',
    body: (mail) => ['Itens entregues:', ...(mail.items ?? [])],
    action: 'Ver o pedido',
  },
};

function layout(input: { preheader: string; greeting: string; heading: string; lines: string[]; details: [string, string][]; actionLabel: string; actionUrl: string; footer: string[] }): string {
  const paragraph = (text: string) => `<p style="margin:0 0 12px;font-size:16px;line-height:24px;color:${COLORS.text};">${escapeHtml(text)}</p>`;
  const detailRows = input.details.map(([label, value]) =>
    `<tr><td style="padding:6px 0;font-size:14px;color:${COLORS.muted};width:120px;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:6px 0;font-size:14px;color:${COLORS.text};">${escapeHtml(value)}</td></tr>`).join('');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(input.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:12px;overflow:hidden;">
<tr><td style="background:${COLORS.nav};padding:16px 24px;font-size:18px;font-weight:700;color:#ffffff;">IT Helpdesk</td></tr>
<tr><td style="padding:24px;">
${paragraph(input.greeting)}
<h1 style="margin:0 0 12px;font-size:20px;line-height:28px;color:${COLORS.text};">${escapeHtml(input.heading)}</h1>
${input.lines.map(paragraph).join('\n')}
${detailRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;border-top:1px solid ${COLORS.border};">${detailRows}</table>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${COLORS.primary};">
<a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;padding:12px 20px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(input.actionLabel)}</a>
</td></tr></table>
<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:${COLORS.muted};">Se o botão não funcionar, copie este endereço no navegador:<br><span style="word-break:break-all;">${escapeHtml(input.actionUrl)}</span></p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid ${COLORS.border};font-size:12px;line-height:18px;color:${COLORS.muted};">
${input.footer.map(escapeHtml).join('<br>')}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function plain(input: { greeting: string; heading: string; lines: string[]; details: [string, string][]; actionLabel: string; actionUrl: string; footer: string[] }): string {
  return [
    input.greeting, '', input.heading, '', ...input.lines, '',
    ...input.details.map(([label, value]) => `${label}: ${value}`), '',
    `${input.actionLabel}: ${input.actionUrl}`, '', '--', ...input.footer,
  ].join('\n');
}

export function renderTicketMail(mail: TicketMail, context: Context): RenderedMail {
  const copy = TICKET_COPY[mail.kind];
  const reference = ticketReference(mail.ticketId);
  const title = headerSafe(mail.ticketTitle, 160);
  const parts = {
    greeting: `Olá, ${firstName(mail.recipientName)}.`,
    heading: copy.heading,
    lines: copy.body(mail),
    details: [['Pedido', reference], ['Assunto', title], ['Data e hora', formatDateTime(mail.occurredAt, context.timezone)]] as [string, string][],
    actionLabel: copy.action,
    actionUrl: `${context.appUrl}/tickets/${encodeURIComponent(mail.ticketId)}`,
    footer: [
      'Mensagem automática do IT Helpdesk. Não responda a este e-mail.',
      'O link pede login e mostra o pedido apenas para quem tem acesso a ele.',
      `Você recebe este aviso porque abriu este pedido. Ajuste os avisos em ${context.appUrl}/account.`,
    ],
  };
  return {
    subject: headerSafe(`${copy.subject} · ${reference} ${title}`),
    html: layout({ ...parts, preheader: `${copy.heading} · ${reference}` }),
    text: plain(parts),
  };
}

export function renderVerificationMail(mail: VerificationMail, context: Context): RenderedMail {
  const parts = {
    greeting: `Olá, ${firstName(mail.recipientName)}.`,
    heading: mail.isChange ? 'Confirme seu novo e-mail' : 'Confirme seu e-mail',
    lines: [
      mail.isChange
        ? 'Recebemos um pedido para usar este endereço na sua conta do IT Helpdesk. Depois de confirmar, ele passa a ser o e-mail de login e de avisos.'
        : 'Confirme este endereço para receber os avisos dos seus pedidos de suporte.',
      `O link vale até ${formatDateTime(mail.expiresAt, context.timezone)} e funciona uma única vez.`,
      'Se não foi você, ignore esta mensagem: nada muda na conta.',
    ],
    details: [] as [string, string][],
    actionLabel: 'Confirmar e-mail',
    actionUrl: mail.confirmUrl,
    footer: ['Mensagem automática do IT Helpdesk. Não responda a este e-mail.'],
  };
  return {
    subject: parts.heading + ' · IT Helpdesk',
    html: layout({ ...parts, preheader: parts.heading }),
    text: plain(parts),
  };
}
