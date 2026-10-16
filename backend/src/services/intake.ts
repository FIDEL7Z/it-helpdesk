import { HttpError } from '../errors/http-error';
import type { TicketCategory, TicketIntake } from '../models/ticket.model';

/**
 * Guided questions shown when someone asks for help, by ticket category. This catalog is the
 * single source: the form reads it from GET /tickets/intake-questions and the API validates
 * answers against it. Questions never ask for passwords, codes or tokens.
 */
export interface IntakeQuestion {
  key: string;
  label: string;
  type: 'choice' | 'text';
  options?: string[];
  maxLength?: number;
  hint?: string;
}

export const INTAKE_TEXT_MAX = 200;

export const INTAKE_QUESTIONS: Record<TicketCategory, IntakeQuestion[]> = {
  hardware: [
    { key: 'equipment', label: 'Qual equipamento está com problema?', type: 'choice',
      options: ['Computador', 'Notebook', 'Monitor', 'Impressora', 'Periférico (mouse, teclado, fone)', 'Outro'] },
    { key: 'powersOn', label: 'O equipamento liga?', type: 'choice', options: ['Sim', 'Não', 'Liga, mas desliga sozinho'] },
    { key: 'symptom', label: 'O que acontece ao tentar utilizá-lo?', type: 'text', maxLength: INTAKE_TEXT_MAX },
  ],
  rede: [
    { key: 'connection', label: 'O problema acontece no Wi-Fi ou na conexão por cabo?', type: 'choice', options: ['Wi-Fi', 'Cabo', 'Nos dois', 'Não sei'] },
    { key: 'behavior', label: 'A internet não funciona ou está instável?', type: 'choice', options: ['Não funciona', 'Está instável ou lenta'] },
    { key: 'othersAffected', label: 'Outras pessoas também estão com esse problema?', type: 'choice', options: ['Sim', 'Não', 'Não sei'] },
  ],
  software: [
    { key: 'program', label: 'Qual programa apresenta o problema?', type: 'text', maxLength: 120 },
    { key: 'behavior', label: 'Ele não abre ou mostra uma mensagem de erro?', type: 'choice',
      options: ['Não abre', 'Mostra uma mensagem de erro', 'Trava ou fecha sozinho', 'Outro comportamento'] },
    { key: 'since', label: 'Quando o problema começou?', type: 'choice', options: ['Hoje', 'Nos últimos dias', 'Há mais de uma semana', 'Não sei'] },
  ],
  acesso: [
    { key: 'system', label: 'Qual sistema você está tentando acessar?', type: 'text', maxLength: 120 },
    { key: 'kind', label: 'É um problema de login ou de permissão?', type: 'choice',
      options: ['Não consigo entrar (login)', 'Entro, mas não tenho permissão', 'Não sei'] },
    { key: 'errorMessage', label: 'Aparece uma mensagem de erro? Se sim, qual?', type: 'text', maxLength: INTAKE_TEXT_MAX,
      hint: 'Não informe senhas, códigos de verificação ou tokens.' },
  ],
  // Other subjects: the free description is enough; no invented technical questions.
  outros: [],
};

export interface IntakeAnswerInput {
  key: string;
  answer: string;
}

/**
 * Keeps only meaningful answers of the chosen category, with the question text as it was asked,
 * so the team can read them even if the catalog changes later. Blank answers are dropped;
 * unknown questions, repeated keys, options outside the list or text over the limit are 400.
 */
export function buildIntakeAnswers(category: TicketCategory, answers: IntakeAnswerInput[]): TicketIntake['answers'] {
  const questions = new Map(INTAKE_QUESTIONS[category].map((question) => [question.key, question]));
  const seen = new Set<string>();
  const result: TicketIntake['answers'] = [];
  for (const { key, answer } of answers) {
    const question = questions.get(key);
    if (!question) throw new HttpError(400, `Unknown question "${key}" for category ${category}`);
    if (seen.has(key)) throw new HttpError(400, `Question "${key}" answered twice`);
    seen.add(key);
    const text = answer.trim();
    if (!text) continue;
    if (question.type === 'choice' && !question.options?.includes(text)) throw new HttpError(400, `Invalid option for "${key}"`);
    if (question.type === 'text' && text.length > (question.maxLength ?? INTAKE_TEXT_MAX)) throw new HttpError(400, `Answer for "${key}" is too long`);
    result.push({ key, question: question.label, answer: text });
  }
  // Catalog order, whatever order the client sent.
  const order = [...questions.keys()];
  return result.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}
