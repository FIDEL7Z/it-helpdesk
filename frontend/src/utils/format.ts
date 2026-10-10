const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
})

export function formatDateTime(isoDate: string | null | undefined): string {
  if (!isoDate) return 'Data não registrada'
  const date = new Date(isoDate)
  return Number.isNaN(date.getTime()) ? 'Data inválida' : dateTimeFormatter.format(date)
}

export const periodLabel = (value: string) => value.length === 7 ? `${value.slice(5)}/${value.slice(0, 4)}` : `${value.slice(8)}/${value.slice(5, 7)}/${value.slice(0, 4)}`
