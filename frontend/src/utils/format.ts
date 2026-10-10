const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
})

export function formatDateTime(isoDate: string | null | undefined): string {
  if (!isoDate) return 'Data não registrada'
  const date = new Date(isoDate)
  return Number.isNaN(date.getTime()) ? 'Data inválida' : dateTimeFormatter.format(date)
}
