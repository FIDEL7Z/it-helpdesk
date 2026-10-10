# Integridade e auditoria dos chamados

[Voltar ao README](../README.md) · [Regras](01-produto-e-regras.md) · [API](03-fluxos-e-api.md)

## Identidades e autoria

Solicitante abre o chamado; responsável é quem está atribuído; autor executa uma ação. Uma identidade não substitui a outra. TI e gestor podem operar e ser responsáveis. Resolver um chamado atribuído a outro responsável exige justificativa de 5–1000 caracteres. Reabertura, alteração de prioridade e reatribuição durante atendimento também exigem motivo.

O backend valida o JWT e consulta o usuário ativo a cada requisição. Autor, snapshots e datas são gerados pelo servidor. O cliente não pode fornecer esses campos, editar o histórico nem modificar projeções de resolução.

## Eventos v2 e escrita atômica

`history[]` preserva os eventos legados e recebe novos eventos com `audit.schemaVersion = 2`. A estrutura contém:

- `eventId` e `operationId`: identificam evento e agrupam eventos da mesma escrita.
- `actorId` e `actorSnapshot`: identidade estável, nome e papel no momento da ação.
- `eventType`, `occurredAt`, `revision` e `eventIndex`: ação, data e ordem dentro da revisão.
- `from` e `to`: valores estruturados que mudaram.
- `assigneeAtEvent` e `assigneeSnapshot`: responsável no momento, separado do autor.
- `cycleId`, `reason` e `dataOrigin`: ciclo, justificativa e origem dos dados.

Os campos antigos `author`, `at`, `type` e `message` continuam presentes nos novos eventos para compatibilidade. Representam o mesmo evento, sem duplicar resoluções. A validação exige consistência entre esses campos e os campos estruturados.

Toda mutação exige `expectedRevision` da leitura efetiva do frontend. Estado, incremento de revisão, eventos e projeções são escritos em uma atualização atômica condicionada à revisão anterior. Falha de precondição retorna 409; a interface informa e recarrega. Não há retry automático de uma intenção baseada em dados antigos.

`operationId` agrupa a escrita; ainda não implementa replay idempotente de resposta HTTP. Reenviar a revisão consumida retorna conflito e não duplica o evento. Não há transação distribuída entre usuários e chamados: mudanças de usuário durante uma requisição em andamento exigem considerar a janela entre validação e escrita.

## Resolução, reabertura e ciclos

Resolução exige responsável ativo/elegível e estado em andamento. Preserva a atribuição e grava `resolvedBy` com o autor autenticado e `resolvedAt` com a data do evento de resolução.

Reabertura exige motivo, incrementa `activeCycleId` e limpa essas projeções do ciclo atual. As resoluções anteriores permanecem no histórico. Um ciclo pode ter uma resolução; novas resoluções exigem reabertura. Ciclos estruturados não reconstruem automaticamente ciclos antigos descritos apenas em texto.

Chamados legados sem esses campos não recebem autor/data de resolução presumidos. A interface direciona ao histórico quando não há projeção estruturada. Eventos sem autor/data retornam null, exibidos como não registrados; IDs existentes continuam disponíveis mesmo se o usuário tiver sido removido.

## Origem dos dados e métricas

`dataOrigin` distingue `operational`, `demo` e `legacy`. Criações pela API com contas demonstrativas reservadas são classificadas como demonstração; outras criações são operacionais. Seeds de exemplo são demonstrativos. Documentos antigos não classificados ficam como legado, sem inclusão automática no conjunto operacional.

Dashboard e lista aceitam filtro por origem. O dashboard seleciona dados operacionais inicialmente. Dados simulados servem à demonstração e não sustentam medidas de produtividade real. Para registros antigos, classificação deve ser explícita e baseada em evidência; a manutenção local autorizada classifica chamados das contas reservadas de demonstração.

A visão gerencial implementa resoluções por autor/ciclo, participação, reaberturas executadas e ranking de solicitações, usando apenas eventos estruturados consistentes para ações e informando cobertura do legado. Duração por ciclo e SLA não são calculados. [Definições e filtros](04-metricas-decisoes-e-limites.md#visão-gerencial-exclusiva). `assignee` indica atribuição; não prova autoria de resolução. `updatedAt` não é data de resolução.

## Usuários e manutenção local

`active = false` bloqueia autenticação, tokens existentes e novas atribuições. Não há tela ou endpoint de administração/desativação nesta etapa. Chamados com responsável desativado/removido precisam de reatribuição antes de iniciar ou resolver. Referências e snapshots históricos são preservados.

O script `backend/src/scripts/normalize-local-demo.ts` renomeia somente as duas contas adicionais autorizadas e classifica dados dessas contas e das contas reservadas do seed. Preserva IDs, credenciais, relacionamentos, datas e eventos; é idempotente, exige `LOCAL_DEMO_MAINTENANCE=1` e restringe a conexão ao banco local de desenvolvimento. Nunca executá-lo em produção.

Histórico embutido continua sujeito ao limite de tamanho do documento MongoDB. Datas futuras existentes bloqueiam novas alterações para revisão de integridade; eventos legados fora de ordem não são silenciosamente reorganizados. A ordem dos novos eventos é definida por revisão/índice, sem inventar timestamps.

## Verificação

`audit.test.ts` cobre resolução por terceiro, gestor, ciclos, revisão ausente/antiga, concorrência, legado incompleto, datas, snapshots, usuários desativados e separação de origens. `manager.test.ts` confere períodos/fuso, autoria, ciclos, duplicação, legado, referências removidas, filtros e isolamento de origens. O E2E verifica justificativa e autoria no histórico/tabela, conflito de uma tela antiga, operações do gestor, três reloads por perfil e viewport de 390 px.
