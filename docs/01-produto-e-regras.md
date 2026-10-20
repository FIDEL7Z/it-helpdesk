# Produto e regras de negócio

[Voltar ao README](../README.md) · [Fluxos e API](03-fluxos-e-api.md)

## Problema e abordagem

O setor de TI recebe solicitações internas em volume, com dificuldade para organizar a fila e acompanhar cada atendimento. O IT-Helpdesk centraliza a abertura, a classificação, a atribuição e o acompanhamento dos chamados. O histórico permite consultar quem realizou as alterações e quando.

O produto atende três necessidades: o solicitante comunica e acompanha seu problema; a TI organiza e executa o atendimento; o gestor consulta o conjunto das demandas com permissão para também operar chamados. Cada perfil tem sua página inicial após o login, com o escopo permitido para aquele usuário. Uma rota protegida acessada anteriormente pode ser restaurada após o login.

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
| Receber auditoria do chamado (justificativas, ciclos, origem, contatos) | Não | Sim | Sim |
| Página inicial | Início: portal de ajuda com busca, assuntos, problemas conhecidos e pedidos próprios | Atendimento: o que precisa de ação, fila pessoal, sem responsável e incidentes ativos | Visão gerencial (Atendimento, Chamados e Artigos no grupo Operação) |
| Visão gerencial e dados de equipe | Não | Não | Exclusiva |
| Publicar, editar, encerrar e republicar incidente | Não | Sim | Sim |
| Ver incidentes ativos e indicar que foi afetado | Sim | Sim | Sim |
| Ler artigos publicados e dizer se ajudaram | Sim | Sim | Sim |
| Escrever, publicar e arquivar artigos | Não | Sim | Sim |
| Confirmar, contestar e avaliar a resolução | Só do próprio chamado | Só do próprio chamado | Só do próprio chamado |
| Ver a fila em Lista ou Quadro | Não (vê “Meus pedidos”) | Sim | Sim |
| Informar departamento, sala e equipamento do problema | Sim (equipamento: só os próprios) | Sim | Sim |
| Ver o material entregue no próprio pedido | Sim, resumido | Sim, com o registro completo | Sim, com o registro completo |
| Consultar estoque, equipamentos e movimentações | Não | Sim | Sim |
| Cadastrar materiais e equipamentos; entradas, reservas, entregas, devoluções, transferências, manutenção e defeito | Não | Sim | Sim |
| Ajuste de inventário, descarte, estorno e baixa de patrimônio | Não | Não | Sim, com justificativa |
| Cadastrar departamentos e salas; definir onde cada pessoa trabalha | Não | Não (consulta) | Sim |
| Indicadores de estoque | Não | Não | Sim |

O endpoint gerencial exige o papel gestor, validado na rota após autenticação. As permissões operacionais estão em [backend/src/auth/permissions.ts](../backend/src/auth/permissions.ts). O frontend mantém uma cópia apenas para controlar a interface. A API aplica a autorização mesmo em chamadas diretas. Status e atribuição exigem permissão na rota; consulta e edição aplicam escopo e propriedade no service.

O solicitante recebe um formato próprio, montado campo a campo no backend: dados do pedido, situação, datas, revisão para editar, nome de quem atende e o histórico com tipo, mensagem, data e nome do autor. Não recebe justificativas internas, metadados de auditoria, ciclos, origem dos dados, IDs ou e-mails de outras pessoas. TI e gestor recebem o formato operacional completo (permissão `tickets:view-audit`).

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

## Incidentes compartilhados

Quando várias pessoas sofrem o mesmo problema (Wi-Fi fora, sistema lento), cada uma tende a abrir um chamado igual. O incidente compartilhado permite que a TI avise uma vez e que cada pessoa afetada diga "também estou com esse problema" sem abrir outro pedido. A equipe passa a ver quantas pessoas foram atingidas.

**Publicação.** TI ou gestor publica a partir de um chamado existente, o chamado principal, com título público (5–120 caracteres) e mensagem para os usuários (10–600). Um chamado tem no máximo um incidente. Chamado resolvido não pode publicar. O texto público é escrito pela equipe; a descrição privada do chamado nunca é exibida a outros usuários.

**Contrato público.** O solicitante recebe somente `id`, `title`, `publicMessage`, `status`, `publishedAt`, `closedAt`, `resolutionMessage`, `affectedCount` e `following`. Não recebe o chamado, sua descrição, solicitante, responsável, histórico nem a lista de participantes. Esse formato é montado explicitamente no backend, não filtrado na interface.

**Participação.** "Também estou com esse problema" grava uma participação do usuário autenticado; o corpo da requisição não aceita outro usuário. Repetir o clique, ou duas requisições simultâneas, mantém uma única participação (índice único por incidente, ciclo e usuário). "Não estou mais com esse problema" marca a saída; voltar reativa o mesmo registro. A contagem de afetados é calculada a partir dessas participações, nunca de um contador incrementado.

**Edição e concorrência.** O incidente tem revisão própria, separada da revisão do chamado. Editar, encerrar e republicar exigem `expectedRevision`; uma tela desatualizada recebe 409 e recarrega. Participar não altera a revisão do incidente nem a do chamado, então muitas pessoas clicando ao mesmo tempo não bloqueiam o atendimento.

**Encerramento.** Resolver o chamado principal encerra o incidente, com o autor da resolução registrado como quem encerrou. Se a gravação do encerramento falhar logo após a resolução, a próxima leitura detecta a resolução e conclui o encerramento, inclusive se o chamado já tiver sido reaberto. Enquanto esse reparo não for gravado, todas as respostas já mostram o incidente como encerrado e ninguém consegue entrar nele. Publicar, republicar ou participar no mesmo instante de uma resolução também termina com o incidente encerrado. TI e gestor também podem encerrar manualmente, com mensagem de encerramento. Depois de encerrado, ninguém entra como afetado; quem acompanhava vê o problema como resolvido. Reabrir o chamado não reativa o incidente: se o problema voltar, a equipe reabre o chamado e republica o incidente, o que inicia um novo ciclo e pede nova confirmação de quem está afetado.

**Auditoria.** Publicação, edição do texto, encerramento e republicação geram eventos com autor, papel, data, revisão, ciclo e valores anteriores/novos. Participações não geram eventos, para não transformar o histórico em um registro de cliques.

**Limites.** Incidentes não avisam ninguém ativamente (nem por e-mail nem push); os e-mails cobrem só o pedido de cada solicitante. Não há vínculo de outros chamados ao incidente nem sugestão automática de incidentes parecidos. O número de afetados mede alcance; não indica quantos chamados deixaram de ser abertos.

Contrato HTTP em [fluxos e API](03-fluxos-e-api.md#incidentes-compartilhados), modelo em [arquitetura e dados](02-arquitetura-e-dados.md#incidentes-e-participações) e indicadores em [métricas](04-metricas-decisoes-e-limites.md#incidentes-compartilhados).

## Base de conhecimento

Artigos de ajuda que evitam pedidos quando a própria pessoa consegue resolver.

- **Quem escreve:** TI e gestor criam, editam, publicam e arquivam. Cada artigo guarda autor, último editor, data da primeira publicação e revisão própria (edição com dados antigos recebe 409).
- **Quem lê:** qualquer pessoa autenticada, apenas artigos **publicados**. Rascunhos e arquivados respondem 404 a quem não é da equipe e nunca aparecem na busca pública.
- **Conteúdo:** texto simples (5–120 caracteres no título, 10–240 no resumo, 30–10.000 no corpo), com parágrafos e listas. Não é Markdown nem HTML: o frontend exibe tudo como texto, então marcações digitadas não são executadas. A categoria é uma das cinco categorias de chamado.
- **Busca:** todas as palavras digitadas (até 8) precisam aparecer no título, no resumo ou no corpo, sem diferença de acentos ou maiúsculas; filtro por categoria e paginação de até 20 itens. Caracteres especiais são tratados literalmente.
- **"A orientação ajudou?":** uma resposta por pessoa e artigo; responder de novo substitui a anterior. Quem lê vê só a própria resposta; os totais aparecem para a equipe; ninguém vê quem votou. Essa resposta não é a avaliação do atendimento de um chamado.
- **"Ainda preciso de ajuda.":** abre o formulário de pedido com o assunto do artigo e o artigo como contexto, ambos removíveis. Nada é criado sem a pessoa enviar.

## Classificação orientada

O formulário pergunta **Com o que você precisa de ajuda?** e traduz a resposta para as categorias existentes, sem criar novas:

| Assunto apresentado | Categoria técnica |
|---|---|
| Computador ou equipamento | `hardware` |
| Internet e conexão | `rede` |
| Programas e aplicativos | `software` |
| Contas e permissões | `acesso` |
| Outro problema | `outros` |

- Cada assunto tem até três perguntas opcionais, de escolha ou texto curto (até 200 caracteres). "Outro problema" usa só a descrição livre. Nenhuma pergunta pede senha, código ou token.
- O catálogo de perguntas existe uma vez, no backend ([intake.ts](../backend/src/services/intake.ts)). O formulário o consulta e a API valida as respostas por ele: pergunta de outro assunto, opção fora da lista, texto longo ou resposta repetida retornam 400; respostas em branco são descartadas.
- As respostas ficam no campo `intake` do chamado, com o texto da pergunta como foi feita, separadas da descrição. A descrição escrita pela pessoa nunca é alterada. Se a pessoa troca de assunto e volta, as respostas do assunto anterior continuam no formulário; só as do assunto final são enviadas.
- O assunto escolhido não define prioridade nem responsável. A TI pode corrigir a categoria pela triagem, com auditoria; o assunto original continua visível em **Informações do pedido**.
- Ao escolher o assunto, o formulário mostra os problemas conhecidos daquele assunto e até três orientações. Nenhum deles impede o envio. Quando a pessoa responde que outras pessoas também estão sem internet e há um incidente de rede, o formulário sugere acompanhá-lo.
- Chamados anteriores, sem `intake`, continuam funcionando normalmente.

## Confirmação de resolução

Depois que a TI resolve, o dono do chamado responde **Seu problema foi resolvido?**

- **Sim:** registra a confirmação (autor e data do servidor) na resolução do ciclo atual. Repetir não cria outra confirmação. Em seguida é oferecida uma avaliação opcional de 1 a 5, com comentário de até 500 caracteres, uma única vez por resolução.
- **Não, o problema continua:** exige motivo (5–1000 caracteres) e reabre o chamado num novo ciclo, com o solicitante como autor da reabertura. A resolução anterior e quem a fez continuam no histórico. A fila da TI mostra **Reaberto pelo solicitante**.
- **Regras:** só o dono responde; TI e gestor recebem 403 ao tentar responder por ele. A resposta informa o ciclo da resolução: ciclo antigo, chamado já reaberto pela TI ou resolução já confirmada retornam 409. Requisições repetidas ou simultâneas não confirmam, avaliam ou reabrem duas vezes, porque usam a mesma revisão do chamado das demais ações. O solicitante continua sem permissão geral de mudar status: a contestação é uma rota própria.
- **Não responder** não é tratado como insatisfação; a visão gerencial mostra "sem resposta" separadamente.

## Estoque e patrimônio

O módulo liga o atendimento ao controle físico do que a TI entrega. O exemplo que guiou as regras: Maria Oliveira, do Financeiro, sala 203, abre um chamado porque o teclado parou; a TI confere o estoque a partir do próprio chamado, entrega um Logitech K120, registra o teclado velho como defeituoso, e o saldo cai exatamente uma unidade, com quem entregou, quem recebeu, onde e por quê.

**Estrutura da empresa.** Uma única empresa, com departamentos e salas cadastrados pela gestão (`org:manage`). Nada é apagado: departamentos e salas são desativados e continuam nos registros antigos. Cada pessoa pode ter um departamento, uma sala e uma função, definidos só pela gestão; ninguém escolhe o próprio departamento pela API.

**Onde o problema acontece.** O pedido pode informar departamento e sala, começando pelo local habitual da pessoa, que ela pode trocar, e o equipamento envolvido (só entre os que ela tem). O chamado guarda o local como era na abertura: se a sala mudar de nome ou a pessoa mudar de setor, o histórico continua apontando o local original. Chamados antigos sem local continuam funcionando.

**Dois modos de controle, fixos no cadastro.** Por quantidade (teclados, mouses, cabos, adaptadores) ou por patrimônio, cada unidade com número de patrimônio único (notebooks, monitores, computadores, impressoras). Um produto nunca é movimentado nos dois modos.

**Saldo por quantidade.** No almoxarifado = unidades utilizáveis guardadas, inclusive reservadas; reservado = separado para um chamado; disponível = no almoxarifado − reservado; com defeito = unidades devolvidas quebradas, mantidas à parte e nunca disponíveis. Nenhum deles fica negativo. Uma reserva não é saída física; uma entrega respeita as reservas. O que foi entregue ou está instalado não é estoque: é contado pelas movimentações.

**Operações.** Entrada, reserva, cancelamento de reserva, entrega (avulsa ou da reserva), devolução em bom estado ou com defeito, ajuste de inventário, descarte de defeituosos e estorno. Ajuste, descarte, estorno e baixa de patrimônio exigem `inventory:adjust` (gestão) e motivo. Um registro nunca é editado: um erro é corrigido por um estorno que aponta o original, e cada movimentação é estornada no máximo uma vez.

**Patrimônio.** Situações: disponível, reservado, em uso, em manutenção, defeituoso e baixado. Só as transições previstas são aceitas (por exemplo, só um equipamento em uso é transferido; baixado é final). Em uso, o equipamento tem departamento, sala e responsável; ao sair de uso, o local de onde saiu fica na movimentação.

**Chamados.** Entregar material não resolve o chamado, e resolver o chamado não dá baixa no estoque: são decisões separadas. O responsável pelo chamado, o autor da resolução, o técnico que registrou a entrega e a pessoa que recebeu são identidades distintas, cada uma registrada como de fato ocorreu. Numa troca, o equipamento com patrimônio retirado vira defeituoso; um periférico sem patrimônio é registrado como unidade com defeito, sem inventar identidade. O solicitante vê só o que foi entregue no próprio pedido: material, quantidade, data, quem entregou e, se recebeu um equipamento, o patrimônio dele. Não vê saldos, custos, outras pessoas nem o estoque.

**Consistência.** Duas retiradas simultâneas do último mouse resultam em uma entrega e uma recusa; repetir a mesma requisição não retira outra unidade. Como funciona: [arquitetura e dados](02-arquitetura-e-dados.md#estoque-patrimônio-e-livro-razão).

## Escopo entregue e evolução futura

**Implementado:** login, chamados persistidos, filtros/paginação, atalhos operacionais, retorno à fila filtrada, atribuição, triagem, ciclos, auditoria, autoria explícita, página inicial própria por perfil, portal do solicitante, incidentes compartilhados, base de conhecimento, classificação orientada, confirmação e avaliação de resolução, quadro (Kanban), estoque e patrimônio integrados aos chamados, notificações por e-mail do próprio pedido para o solicitante (com confirmação do endereço, preferências e modo local Mailpit), visão gerencial exclusiva com filtros e métricas comprovadas, tema claro por padrão com opção de tema escuro no cabeçalho e layout responsivo.

A visão gerencial separa situação atual, criação no período e ações do autor no período. Inclui operadores com zero chamados, gestores operadores e referências históricas indisponíveis. Nenhuma contagem isolada representa qualidade do atendimento.

**Assistente:** chat consultivo para os três perfis, com as respostas montadas só a partir do que cada perfil pode ver; IA generativa via Google Gemini ou Cloudflare Workers AI quando configurada (`AI_PROVIDER`), modo demonstrativo identificado sem ela. Detalhes no [README](../README.md#assistente).

**Ainda não implementado:** busca semântica no assistente, compras, fornecedores, custos e notas fiscais, leitor de código de barras, campo de impacto, intervalo personalizado, SLA/tempos úteis, evolução histórica do backlog, notificações push e avisos à equipe, anexos, administração de contas e protótipos Figma. Não há campo `impact` no schema atual. Essas propostas não são apresentadas como telas ou comandos disponíveis.
