import { ApiError } from '../services/api'

/** Turns API errors into messages for the user (the API answers in English). */
export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 0:
        return 'Não foi possível conectar ao servidor. Tente novamente em instantes.'
      case 400:
        return 'Os dados enviados são inválidos. Revise os campos e tente novamente.'
      case 403:
        return 'Você não tem permissão para realizar esta ação.'
      case 404:
        return 'Chamado não encontrado.'
      case 409:
        return 'O chamado foi alterado por outra pessoa ou não permite esta ação no status atual. Os dados foram atualizados.'
    }
  }
  return 'Ocorreu um erro inesperado. Tente novamente.'
}
