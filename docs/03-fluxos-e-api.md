# Fluxos, ciclo de vida e API

[Voltar ao README](../README.md) · [Permissões](01-produto-e-regras.md#permissões-implementadas) · [Demonstração](05-demonstracao.md)

## Como usar, por perfil

### Solicitante

1. Entre com seu e-mail. A página **Início** mostra **Problemas conhecidos** (quando houver) e **Meus pedidos**.
2. Se um problema conhecido também está afetando você, clique em **Também estou com esse problema**. Nada mais é necessário: a TI vê que mais uma pessoa foi atingida. Se o problema passar, clique em **Não estou mais com esse problema**.
3. Para outro problema, clique em **Solicitar suporte**. Antes do formulário aparecem os problemas conhecidos; eles não impedem o envio. Preencha **Assunto**, **O que aconteceu?**, **Tipo de problema** e **Prioridade sugerida**, e clique em **Enviar solicitação**.
4. Após o envio, a página do pedido abre com a confirmação. A situação aparece como **Aguardando atendimento**, **Em atendimento** ou **Resolvido**. Enquanto ninguém iniciou o atendimento, **Editar chamado** permite corrigir o texto.
5. Em **Meus pedidos**, acompanhe todos os pedidos. Quando a TI encerra um problema que você acompanhava, ele aparece em **Problemas que você acompanhou**, na página Início, como resolvido.

### Suporte TI

1. A página **Atendimento** mostra os **Incidentes ativos** com o número de pessoas afetadas, as contagens da fila e os chamados recentes. **Ver fila de chamados** abre as pendências.
2. Na lista **Chamados**, use os atalhos **Sem responsável**, **Atribuídos a mim** e **Em andamento**, a busca e os filtros. Chamados com incidente publicado têm a marca **Incidente · N pessoas afetadas**.
3. No chamado, o bloco **Atendimento** permite escolher o responsável e **Atribuir**, ajustar categoria/prioridade com **Salvar classificação**, **Iniciar atendimento** e **Marcar como resolvido**. Algumas ações pedem motivo (reatribuição, prioridade durante o atendimento, resolução de chamado de outro responsável, reabertura).
4. Quando o problema atinge mais pessoas, use **Publicar como incidente** no bloco **Incidente compartilhado** do chamado. Escreva um título e uma mensagem para os usuários, sem dados do chamado original, e clique em **Publicar incidente**. O bloco mostra o texto exatamente como os usuários o veem e quantas pessoas informaram que estão afetadas.
5. **Editar comunicação** atualiza o texto público. Ao resolver o chamado, o incidente é encerrado automaticamente; **Encerrar incidente** permite encerrar antes, com uma mensagem de encerramento. Se o problema voltar, reabra o chamado e use **Republicar**.

### Gestor

1. O login abre a **Visão gerencial**. Escolha o **Período** (e a **Origem dos dados**, presente só no modo demonstração); **Filtros de equipe e classificação** refinam por analista, solicitante, categoria, prioridade e status.
2. **Precisa de atenção** reúne alertas que abrem a fila correspondente. **Equipe de suporte** e **Carga por responsável e prioridade** mostram a distribuição atual; **Ver chamados** abre a fila do analista.
3. **Incidentes compartilhados** mostra quantos estão ativos, quantas pessoas estão afetadas, novas adesões em 30 dias, encerrados e os incidentes com mais afetados, com link para o chamado principal.
4. Pelos menus **Atendimento** e **Chamados**, o gestor opera chamados como a TI: assume, atribui, classifica, resolve, reabre e publica incidentes. O texto de chamados de outras pessoas continua restrito ao autor.

Filtros na lista ficam na URL e sobrevivem a recarregamentos e ao botão Voltar do navegador. Ao abrir um chamado pela lista, o link explícito do detalhe restaura a URL dessa fila, incluindo filtros e página. Acesso direto ao detalhe usa `/tickets` como fallback.

## Visão gerencial

Menu **Visão gerencial** (`/manager`) separado de **Operação de chamados** (`/tickets`). Login normal do gestor abre a visão gerencial; uma rota protegida anteriormente consultada pode ser restaurada. TI e solicitante recebem 403 no endpoint gerencial, mesmo em requisições diretas, e são redirecionados ao próprio dashboard ao tentar a página.

`GET /dashboard/manager` aceita `period=today|week|month|year` (padrão `month`), `dataOrigin=operational|demo|legacy` (padrão `operational`), `analystId`, `requesterId`, `category`, `priority` e `status`. IDs devem ser ObjectId; campos desconhecidos/valores inválidos retornam 400. Limites, timezone e instante da consulta retornam em `range` e `asOf`.

Resposta contém `current`, `period`, `alerts`, `workload`, `distributions`, `team`, `requesters`, `trends`, `demand`, `coverage` e opções públicas de filtro. A interface mantém filtros gerenciais na URL. Links de equipe e alertas abrem pendências atuais de qualquer data de criação. Links de solicitantes e criações incluem os limites exatos do período consultado. Cartões de backlog usam `pending=true`; nenhuma resolução é inferida do responsável atual.

Consulte [definições dos indicadores](04-metricas-decisoes-e-limites.md#visão-gerencial-exclusiva).

## Estados permitidos

```mermaid
stateDiagram-v2
  [*] --> aberto: Usuário autenticado cria
  aberto --> em_andamento: TI ou gestor inicia
  em_andamento --> resolvido: TI ou gestor resolve
  resolvido --> em_andamento: TI ou gestor reabre
```

TI e gestor mudam status. Não há transição direta de aberto para resolvido nem retorno ao estado aberto. Transição inválida retorna 409.

Ao passar para `em_andamento`, inclusive ao reabrir, o operador autenticado assume automaticamente se o chamado estiver sem responsável; uma atribuição existente é preservada. Enquanto não resolvido, TI e gestor podem atribuir ou trocar o responsável, reclassificar categoria e prioridade. A API atual não remove o responsável.

Título/descrição seguem a regra de dono e estado aberto. Não é permitido usar a edição genérica para mudar status, responsável, solicitante ou histórico.

## Histórico e concorrência

O servidor gera autor, data e descrição de cada evento. Criação, edição, mudança de status, reabertura e atribuição são registradas. Atualização sem mudança de valor não cria evento de edição; iniciar um chamado sem responsável cria eventos de status e atribuição.

`saveChanges` grava estado, revisão, eventos e projeções de resolução na mesma atualização atômica. A condição usa `expectedRevision`, enviada a partir da leitura efetiva do frontend. Uma alteração concorrente ou tela antiga retorna 409 sem gravar estado ou evento parcial. O frontend recarrega e informa o conflito.

Resolução por outro responsável exige `reason`; reabertura também. `resolvedAt`/`resolvedBy` descrevem apenas a resolução do ciclo atual e são limpos na reabertura. Todas as resoluções anteriores permanecem em eventos próprios. Datas/autores legados ausentes não são preenchidos automaticamente.

Fonte: [ticket.service.ts](../backend/src/services/ticket.service.ts).

## Referência HTTP

Base local: `http://localhost:3000/api`. Rotas autenticadas exigem `Authorization: Bearer <token>`. Respostas são JSON.

| Método | Rota | Contrato e acesso |
|---|---|---|
| GET | `/health` | Público; `{ status: "ok" }` |
| POST | `/auth/login` | Público com rate limit; `{ email, password }` → `{ token, user }` |
| GET | `/auth/me` | Usuário autenticado → `{ user }` |
| POST | `/tickets` | `{ title, description, category, priority? }`; qualquer perfil autenticado |
| GET | `/tickets` | Escopo autorizado; filtros e paginação → `{ tickets, pagination }` |
| GET | `/tickets/:id` | Dono, TI ou gestor → `{ ticket }` com histórico; o dono solicitante recebe o [formato reduzido](01-produto-e-regras.md#permissões-implementadas) |
| PATCH | `/tickets/:id` | Texto próprio aberto; categoria/prioridade TI/gestor; `expectedRevision` obrigatório e não resolvido |
| PATCH | `/tickets/:id/status` | TI/gestor; `{ status, expectedRevision, reason? }`, conforme transições |
| PATCH | `/tickets/:id/assignee` | TI/gestor; `{ assigneeId, expectedRevision, reason? }`, destino operador ativo e chamado não resolvido |
| GET | `/users/it-staff` | TI ou gestor; lista operadores ativos atribuíveis (TI/gestor) |
| GET | `/dashboard/summary` | Escopo autorizado; `dataOrigin?` → `{ summary }` |
| GET | `/dashboard/manager` | Somente gestor; filtros gerenciais → `{ dashboard }` |
| GET / POST | `/tickets/:id/incident` | TI/gestor; consulta (`{ incident }` ou `null`) ou publica `{ title, publicMessage }` → 201 |

Lista aceita `dataOrigin` (`operational`/`demo`/`legacy`), `status`, `priority`, `category`, `assignee` (`none`/`me`), `search` por título, `page` (padrão 1) e `limit` (padrão 10, máximo 50). Pesquisa tem limite de 100 caracteres. O frontend oferece filtro de responsável para TI e gestor. IDs inválidos retornam 400. `assigneeId` permite consultar responsável específico para TI/gestor; `requesterId` filtra solicitante sem ampliar o escopo autorizado. Solicitante não pode consultar outros IDs. `pending=true` restringe a abertos/em andamento; combinado com status resolvido retorna fila vazia.

Erros têm `message`; validações também podem incluir `errors` por campo e `formErrors`. Códigos: 400 entrada inválida; 401 autenticação inválida/ausente/expirada; 403 sem permissão; 404 recurso ausente ou chamado alheio ao solicitante; 409 conflito de alteração/estado; 413 corpo acima de 100 KB; 429 limite de login; 500 falha inesperada sem stack na resposta.

### Incidentes compartilhados

Rotas em `/api/incidents`, todas autenticadas. Regras e motivos em [produto e regras](01-produto-e-regras.md#incidentes-compartilhados).

| Método | Rota | Acesso e contrato |
|---|---|---|
| GET | `/incidents` | Todos os perfis; incidentes ativos no formato público → `{ incidents }` |
| GET | `/incidents/following` | Incidentes em que o usuário está como afetado, ativos ou encerrados |
| GET | `/incidents/:id` | Formato público; encerrado só para quem participou ou para a equipe, senão 404 |
| GET / PUT / DELETE | `/incidents/:id/participation` | Própria participação: consultar, entrar (corpo `{}`) ou sair; incidente encerrado → 409 |
| GET | `/incidents/manage` | TI/gestor; `status?`, `dataOrigin?` → visão da equipe com chamado, responsável e histórico |
| GET | `/incidents/indicators` | TI/gestor; `dataOrigin?` → `{ active, closed, affectedInActive, newParticipations30Days, top }` |
| PATCH | `/incidents/:id` | TI/gestor; `{ title?, publicMessage?, expectedRevision }`, somente ativo |
| POST | `/incidents/:id/close` | TI/gestor; `{ resolutionMessage, expectedRevision }` |
| POST | `/incidents/:id/republish` | TI/gestor; `{ title, publicMessage, expectedRevision }`, somente encerrado e com chamado não resolvido |

Entrar duas vezes devolve 200 com a mesma contagem. O corpo de participação não aceita `userId`: enviar campos extras retorna 400. A lista de chamados inclui `incident: { id, status, affectedCount }` apenas para TI/gestor. Publicar em chamado resolvido, publicar de novo no mesmo chamado ou usar uma revisão antiga retorna 409.

### Filtros dos alertas e do período de criação

`GET /api/tickets` aceita `attention=high_unassigned|oldest|inactive`, `ageDays` (1–365, padrão 7) e `inactivityDays` (1–90, padrão 3). Os predicados são os mesmos da visão gerencial; `oldest` ordena a fila por abertura crescente. Combinam-se com origem, classificação, solicitante, responsável e paginação, sem ampliar a autorização do usuário.

`createdFrom` e `createdTo` aceitam datas ISO com horário UTC; início inclusivo e fim exclusivo. Os links de volume por solicitante incluem o intervalo exato retornado pela API. Carga atual e alertas não recebem esse intervalo, pois consideram pendências de qualquer data de abertura. Links de detalhe preservam a URL da fila ao retornar.

`GET /api/dashboard/manager` também aceita os dois limiares de dias. Origens `demo`/`legacy` retornam 403 se `DEMO_MODE` estiver desabilitado ou `NODE_ENV=production`; a origem padrão é operacional.

## Capturas por perfil

Imagens reais do ambiente demonstrativo, em 15/10/2026, com viewport desktop de 1440 × 900 e celular de 390 × 844. As páginas iniciais são capturas da página inteira; as demais mostram o trecho indicado. As capturas não criaram nem alteraram chamados. Registros de testes manuais anteriores, como títulos digitados ao acaso, permanecem preservados; os números refletem aquele momento, não uma instalação nova.

<details>
<summary>Solicitante: login, Início, pedido e problema conhecido</summary>

![Login sem credenciais preenchidas, com servidor disponível](assets/screenshots/login-desktop.png)

O login autentica os três perfis; não há cadastro público.

![Página Início da solicitante com Solicitar suporte, problema conhecido e Meus pedidos](assets/screenshots/dashboard-solicitante-desktop.png)

A solicitante vê seus pedidos e os problemas que a TI já publicou.

![Problema conhecido acompanhado pela solicitante, com a opção de sair](assets/screenshots/incidente-solicitante-desktop.png)

Depois de **Também estou com esse problema**, o cartão confirma o acompanhamento e oferece **Não estou mais com esse problema**.

![Formulário Solicitar suporte com o problema conhecido exibido antes dos campos](assets/screenshots/abertura-chamado-desktop.png)

O formulário mostra os problemas conhecidos antes dos campos, sem bloquear o envio. A captura é anterior ao envio.

![Página Início da solicitante no celular](assets/screenshots/dashboard-solicitante-mobile.png)

</details>

<details>
<summary>Atendimento da TI, listagem e incidente</summary>

![Página Atendimento da TI com incidentes ativos, contagens e chamados recentes](assets/screenshots/dashboard-ti-desktop.png)

O incidente de demonstração aparece identificado como tal; as contagens abaixo seguem a origem escolhida.

![Bloco Incidente compartilhado no chamado principal, com afetados e texto público](assets/screenshots/incidente-ti-desktop.png)

No chamado principal, a equipe vê quantas pessoas estão afetadas e o texto exatamente como os usuários o recebem.

![Lista de chamados demonstrativos com solicitante, responsável atribuído e autor da resolução](assets/screenshots/lista-chamados-desktop.png)

A lista foi filtrada pelo título do conjunto gerencial fictício. As três identidades têm colunas próprias. Registros legados sem evidência estruturada, consultados em outras filas, continuam identificados como tal.

</details>

A jornada do gestor está nas [capturas dos indicadores](04-metricas-decisoes-e-limites.md#evidências-visuais). O [detalhe com histórico](06-integridade-e-auditoria.md#evidência-visual-da-autoria) demonstra autoria diferente da atribuição.
