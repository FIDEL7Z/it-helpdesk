# Produto e regras de negócio

[Voltar ao README](../README.md) · [Fluxos e API](03-fluxos-e-api.md)

## Problema e abordagem

O setor de TI recebe solicitações internas em volume, com dificuldade para organizar a fila e acompanhar cada atendimento. O IT-Helpdesk centraliza a abertura, a classificação, a atribuição e o acompanhamento dos chamados. O histórico permite consultar quem realizou as alterações e quando.

O produto atende três necessidades: o solicitante comunica e acompanha seu problema; a TI organiza e executa o atendimento; o gestor consulta o conjunto das demandas com permissão para também operar chamados. O dashboard aparece após o login normal e mantém o escopo permitido para cada usuário. Uma rota protegida acessada anteriormente pode ser restaurada após o login.

## Como pensei na solução

> Primeiro analisei o problema operacional da TI: receber muitas solicitações sem uma organização clara dificulta o atendimento e o acompanhamento. Identifiquei necessidades diferentes para o solicitante, o suporte e o gestor. Organizei a solução em torno da abertura, do atendimento e do acompanhamento dos chamados, considerando segurança, rastreabilidade e facilidade de uso. Priorizei uma aplicação funcional, com autenticação, persistência e histórico, antes de recursos avançados.

Texto revisado e confirmado pelo autor. Não descreve entrevistas, pesquisa de campo ou testes com usuários.

## Permissões implementadas

| Ação | Solicitante | TI | Gestor |
|---|---|---|---|
| Abrir chamado | Sim | Sim | Sim |
| Ver chamados e histórico | Próprios | Todos | Todos |
| Editar título e descrição | Próprio, aberto | Próprio, aberto | Próprio, aberto |
| Triar categoria e prioridade | Não | Se não resolvido | Se não resolvido |
| Alterar status e reabrir | Não | Transições permitidas | Transições permitidas |
| Atribuir responsável | Não | Se não resolvido; destino TI/gestor ativo | Mesma regra |
| Ser responsável | Não | Sim | Sim |
| Consultar equipe TI | Não | Sim | Sim |
| Dashboard básico | Próprio | Global e fila pessoal | Global (rota disponível) |
| Visão gerencial e dados de equipe | Não | Não | Exclusiva |

O endpoint gerencial exige o papel gestor, validado na rota após autenticação. As permissões operacionais estão em [backend/src/auth/permissions.ts](../backend/src/auth/permissions.ts). O frontend mantém uma cópia apenas para controlar a interface. A API aplica a autorização mesmo em chamadas diretas. Status e atribuição exigem permissão na rota; consulta e edição aplicam escopo e propriedade no service.

O papel vem do usuário no banco a cada requisição, não do JWT. Usuário removido ou desativado é rejeitado. Para solicitante, consultar o chamado de outra pessoa retorna 404, evitando confirmar sua existência.

## Criação e edição

- Título: 3–120 caracteres; descrição: 10–5000, após remoção de espaços nas extremidades.
- Categorias: `hardware`, `software`, `rede`, `acesso`, `outros`.
- Prioridades: `baixa`, `media`, `alta`. **Na versão atual, todos os perfis podem informar prioridade na criação.** Se omitida na API, o servidor usa `media`.
- O solicitante do chamado vem do usuário autenticado. `requester`, `status`, `assignee` e `history` não podem ser enviados na criação.
- Chamados começam em `aberto`, sem responsável, com evento de criação gerado no servidor.
- Somente o dono edita título/descrição, enquanto o chamado está aberto. A TI também segue essa regra para o texto de seus próprios chamados.
- TI e gestor editam categoria/prioridade, desde que o chamado não esteja resolvido.
- Atualização com os mesmos valores não gera evento de edição. Alterações reais acrescentam histórico.

As regras de propriedade e alteração estão em [ticket.service.ts](../backend/src/services/ticket.service.ts); os contratos de entrada, em [ticket.controller.ts](../backend/src/controllers/ticket.controller.ts).

## Auditoria e integridade

Toda alteração exige `expectedRevision` da leitura do frontend. Conflitos retornam 409 e recarregam os dados; o usuário precisa revisar antes de tentar novamente. Prioridade e reatribuição durante atendimento exigem motivo. Resolução por outro responsável exige justificativa; resolução sem responsável é bloqueada. Reabertura exige motivo, inicia novo ciclo e preserva as resoluções anteriores.

Novos eventos registram autor autenticado, snapshot de identidade, responsável no momento, valores anteriores/novos, data, revisão e ciclo. Eventos legados permanecem intactos; informação ausente é exibida como não registrada. Veja [integridade e auditoria](06-integridade-e-auditoria.md).

## Escopo entregue e evolução futura

**Implementado:** login, chamados persistidos, filtros/paginação, atalhos operacionais, retorno à fila filtrada, atribuição, triagem, ciclos, auditoria, autoria explícita, dashboards por perfil, visão gerencial exclusiva com filtros e métricas comprovadas, temas seguindo o sistema e layout responsivo.

A visão gerencial separa situação atual, criação no período e ações do autor no período. Inclui operadores com zero chamados, gestores operadores e referências históricas indisponíveis. Nenhuma contagem isolada representa qualidade do atendimento.

**Ainda não implementado:** campo de impacto, intervalo personalizado, SLA/tempos úteis, evolução histórica do backlog, notificações, anexos, administração de contas e protótipos Figma. Não há campo `impact` no schema atual. Essas propostas não são apresentadas como telas ou comandos disponíveis.
