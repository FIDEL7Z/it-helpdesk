# Métricas, decisões técnicas e limites

[Voltar ao README](../README.md) · [Arquitetura e dados](02-arquitetura-e-dados.md)

## Dashboard básico

O solicitante consulta só seus documentos; TI e gestor consultam todos. O resumo aceita filtro de origem (`operational`, `demo`, `legacy`), sem filtro por período. O frontend seleciona operacional inicialmente; demonstração e legado ficam separados. Valores representam o estado atual dos chamados, não produtividade, qualidade ou desempenho histórico.

| Indicador / pergunta | Definição e campos | Filtros e limitações |
|---|---|---|
| Total: qual o volume registrado? | Contagem de documentos | Escopo autorizado, todos os status; sem período |
| Abertos, em andamento, resolvidos: qual a situação atual? | Contagem por `status` | Resolvidos = atualmente resolvidos, não resoluções de um período |
| Pendentes por prioridade: quais pendências exigem atenção? | Agrupamento por `priority` | Apenas `aberto`/`em_andamento`; classificação atual |
| Pendentes por categoria: onde as pendências se concentram? | Agrupamento por `category` | Apenas `aberto`/`em_andamento`; não é distribuição de todos os chamados |
| Sem responsável: quantos documentos não estão atribuídos? | `assignee = null` | Todos os status; só no workload TI; pode incluir resolvidos |
| Em atendimento comigo: quanto está sob minha responsabilidade? | `assignee = usuário atual` e `status = em_andamento` | Só TI; não inclui abertos atribuídos nem identifica quem resolveu |
| Recentes: quais foram criados por último? | Até 5 documentos por `createdAt desc`, depois `_id desc` | Escopo autorizado; recente significa criado, não atualizado |

As contagens usam `$facet` após o filtro de autorização. Lista e dashboard compartilham `buildTicketFilter`, então adotam as mesmas definições de escopo e filtro. Agregação, recentes e contagem da lista são consultas separadas: alterações simultâneas podem produzir diferenças entre momentos de leitura.

Cartões de status abrem a lista com o filtro correspondente. “Sem responsável” abre `assignee=none`; “Em atendimento comigo”, `assignee=me&status=em_andamento`.

Fonte: [dashboard.service.ts](../backend/src/services/dashboard.service.ts).

## Visão gerencial exclusiva

Somente gestor acessa `/manager` e `GET /api/dashboard/manager`. O painel separa indicadores de período e de situação atual; não constitui avaliação definitiva de qualidade da equipe.

### Períodos, origem e filtros

`today`: desde 00h local de hoje; `week`: desde 00h de seis dias atrás, incluindo hoje; `month`: desde o primeiro dia do mês; `year`: desde 1º de janeiro. Todos usam intervalo `[início, instante da consulta)`, com `APP_TIMEZONE` (IANA, padrão `America/Fortaleza`). Ano agrupa tendências por mês; demais períodos, por dia. Não há intervalo personalizado.

Origem padrão `operational`. `demo` mantém dados fictícios separados; `legacy` inclui documentos sem origem ou classificados explicitamente como legado. Selecionar legado não inventa eventos: somente ações v2 comprovadas podem integrar produtividade, mesmo nesse conjunto. Simulações não sustentam avaliação operacional.

Solicitante filtra `requester`; categoria, prioridade e status filtram o **estado atual** do chamado em todas as consultas. Não reconstituem classificação histórica. Analista tem dois sentidos explícitos: responsável atual nas contagens de estado/criação/ranking e autor autenticado nos indicadores de eventos. Por isso, resolver chamado de outro pode produzir resoluções maiores que sua carga atual. Combinar filtros pode excluir um chamado hoje resolvido ou reclassificado de uma série; a tela informa essa semântica.

### Definições

- **Criados no período:** documentos com `createdAt` no intervalo, de qualquer status; também chamado volume de aberturas. Não representa apenas status aberto.
- **Resoluções no período:** eventos v2 `resolved` válidos, agrupados por ID do chamado e `cycleId`, com data no intervalo. **Chamados distintos resolvidos** conta IDs únicos; duas resoluções em dois ciclos somam duas ações e um chamado distinto.
- **Em andamento agora:** documentos com status `em_andamento`; não depende da data de criação.
- **Backlog atual:** abertos + em andamento, sob filtros atuais. Não é backlog reconstruído de meses anteriores.
- **Pendentes sem responsável:** backlog com `assignee=null` ou ausente. Difere do cartão básico TI, que inclui todos os status sem responsável. O link gerencial acrescenta `pending=true` à fila.
- **Distribuições por prioridade/categoria:** classificação atual do backlog, sem corte por criação.
- **Atribuídos agora por operador:** documentos de todos os status com seu `assignee`. **Pendentes** exclui resolvidos; **em andamento** é um subconjunto das pendências.
- **Resoluções por operador:** ações comprovadas pelo `actorId`, nunca pelo responsável atual ou `resolvedBy` isolado. Um gestor que resolve aparece como gestor operador.
- **Participação:** chamados distintos com ao menos uma ação v2 válida do operador no período. Várias ações no mesmo chamado contam uma participação por autor; o mesmo chamado pode ter participação de vários operadores, portanto não somar como total de chamados únicos da equipe.
- **Reaberturas por operador:** eventos v2 `reopened`, uma vez por chamado e novo ciclo, executados pelo próprio autor no período. Não atribuem falha/culpa ao resolvedor anterior ou responsável atual.
- **Solicitantes:** até dez maiores volumes de criação no período, com empate por ID estável. Categorias são agrupadas nos mesmos documentos; a tela mostra as três mais frequentes. Pendências pertencem a esse conjunto criado no período. Usuários TI/gestor também podem abrir solicitações.
- **Tendências:** criações por `createdAt` e resoluções por data do evento; exibem somente períodos com registros. Zero na outra série representa ausência de registros nesse período, sem preenchimento fictício.
- **Demanda horária/semanal:** criações no período agrupadas por hora local (0–23) e dia ISO da semana (segunda–domingo), sem extrair horário de mensagens ou `updatedAt`.

Equipe inclui TI, gestores operadores e referências históricas/atribuídas pertinentes. Operadores sem chamados aparecem com zero; removidos usam ID/snapshot disponível, sem inventar identidade. A ordem por pendências auxilia triagem, sem premiar baixo volume de resolução ou penalizar alta carga. Links da equipe/solicitantes consultam a fila atual, **sem período de criação**.

### Evidência e cobertura

A agregação exige schema v2, ID de evento, autor ObjectId, papel TI/gestor no snapshot, data válida não futura e consistência entre `author`/`actorId`, `type`/`eventType`, `at`/`occurredAt` e origem do documento/evento. Resolução deve registrar transição de em andamento para resolvido; reabertura, de resolvido para em andamento.

Resoluções repetidas no mesmo chamado/ciclo contam uma vez. Se há autores contraditórios no ciclo, nenhuma recebe crédito. A data mínima comprovada define o ciclo para agregação; duplicatas não deslocam a mesma resolução para outro período. Reabertura preserva eventos de resoluções anteriores, mesmo que `resolvedAt`/`resolvedBy` atuais sejam limpos.

`coverage.resolvedWithoutStructuredHistory` conta chamados **atualmente resolvidos** sem evidência válida do ciclo atual, sob filtros de carga. `coverage.conflictingResolutionCycles` informa ciclos de resolução com autores contraditórios cuja primeira data válida está no período, sob os demais filtros de documento; é um alerta de integridade, não uma contagem atribuída ao analista selecionado. Esses conjuntos podem se sobrepor. Eventos legados de texto não entram em produtividade; criação e situação atual continuam consultáveis quando seus campos existem.

Fontes: [manager.service.ts](../backend/src/services/manager.service.ts), [contrato HTTP](03-fluxos-e-api.md#visão-gerencial) e [auditoria](06-integridade-e-auditoria.md). Estado, eventos e usuários são lidos em consultas separadas; uma atualização simultânea pode aparecer na próxima consulta.

### Ainda não calculado

SLA, tempo médio/corrido/útil de atendimento, duração completa por ciclo e evolução histórica de backlog exigem definições adicionais e cobertura confiável. `updatedAt` não é data de resolução. Não há ranking de qualidade, pontuação de desempenho ou dados artificiais para preencher gráficos.

## Decisões presentes no código

As justificativas abaixo explicam efeitos e tradeoffs da arquitetura existente, sem afirmar quais alternativas o autor considerou pessoalmente.

- **SPA React/Vite:** navegação interna sem necessidade atual de SSR; execução de frontend e API separadas. Não há renderização no servidor.
- **JWT Bearer no localStorage:** integração simples; assinatura verifica autenticidade, não criptografa o conteúdo. XSS pode expor o token. Logout limpa a sessão local, sem revogar uma cópia já emitida.
- **Usuário consultado a cada requisição:** papel atualizado e rejeição de usuário removido/desativado, com custo de uma consulta por ID.
- **Permissões centralizadas no backend:** revisão objetiva do RBAC; a cópia do frontend precisa ser mantida coerente e não concede acesso por si só.
- **Zod e endpoints por ação:** entrada validada e restrição dos campos de escrita. Edição, status e atribuição têm contratos separados.
- **Histórico embutido e escrita atômica:** evento e alteração do chamado são gravados juntos. Crescimento do histórico aumenta o documento; o porte atual não motivou coleção separada.
- **Revisão numérica:** toda mutação exige a revisão consultada pelo frontend; conflitos retornam 409. Eventos e projeções são gravados atomicamente com incremento de revisão.
- **Filtro compartilhado e facet:** reaproveita escopo e concentra contagens. Não garante snapshot único entre todas as consultas.
- **Busca literal com regex escapada:** evita tratar entrada como expressão regular; sem índice de texto, volumes altos podem exigir outra estratégia.
- **bcryptjs e node:test:** hash em JavaScript e testes sem biblioteca de testes adicional. Integração exige MongoDB real.
- **CSS próprio e Docker só no banco:** preserva a identidade visual e reduz dependências, com manutenção manual de componentes e processos separados.

## Segurança e limites operacionais

Senhas são armazenadas como hash e não retornadas pela API. JWT exige segredo de ao menos 32 caracteres e fixa HS256. Login usa mensagem genérica e comparação com hash fictício para reduzir diferenças entre usuário inexistente e senha incorreta; isso não é garantia absoluta contra inferências por tempo.

Login limita 10 tentativas por IP a cada 15 minutos, incluindo sucessos. O contador é em memória: reinício o limpa, instâncias não o compartilham e usuários atrás do mesmo IP dividem o limite. Proxy reverso requer configuração apropriada de IP/trust proxy.

CORS restringe origens configuradas; autenticação/autorização continuam responsáveis pelo acesso. Express não anuncia `X-Powered-By`, limita JSON a 100 KB e responde erros sem stack trace.

MongoDB local roda sem autenticação, publicado somente em loopback. Produção exige configuração própria de banco e segredos. `.env` e variantes são ignorados pelo Git; `.env.example` tem apenas configuração e credenciais demonstrativas.

Não há cadastro público, recuperação de senha, administração de perfis na interface, comentários, anexos ou notificações. Dashboards não atualizam em tempo real; a visão gerencial possui botão de atualização e filtros por período. Não há SLA ou ranking de qualidade da equipe. O tema segue o sistema; não existe seletor manual.

O timeout de um E2E antigo permanece sem causa determinada; os scripts/registros daquela execução não estão disponíveis. O E2E atual é reproduzível e registra diagnóstico em falhas, mas uma execução aprovada não prova ausência de intermitência. Requisições do cliente de produção não possuem timeout explícito.
