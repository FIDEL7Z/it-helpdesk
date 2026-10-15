import { ApiError } from '../services/api'

type ErrorContext = 'ticket' | 'incident'

/** Turns API errors into messages for the user (the API answers in English). */
export function getErrorMessage(error: unknown, context: ErrorContext = 'ticket'): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 0:
        return 'Não foi possível conectar ao servidor. Tente novamente em instantes.'
      case 400:
        return 'Os dados enviados são inválidos. Revise os campos e tente novamente.'
      case 403:
        return 'Você não tem permissão para realizar esta ação.'
      case 404:
        return context === 'incident' ? 'Este problema não está mais disponível.' : 'Chamado não encontrado.'
      case 409:
        return context === 'incident'
          ? 'Este problema foi atualizado ou encerrado por outra pessoa. Os dados foram recarregados.'
          : 'O chamado foi alterado por outra pessoa ou não permite esta ação no status atual. Os dados foram atualizados.'
      case 429:
        return 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.'
    }
  }
  return 'Ocorreu um erro inesperado. Tente novamente.'
}
