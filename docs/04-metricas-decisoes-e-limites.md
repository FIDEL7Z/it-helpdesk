# Métricas, decisões técnicas e limites

[Voltar ao README](../README.md) · [Arquitetura e dados](02-arquitetura-e-dados.md)

## Indicadores implementados

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

## Métricas propostas, ainda não implementadas

- **Pendências atuais:** soma de abertos e em andamento, calculável com a resposta existente. Seria um novo destaque visual, não uma nova regra.
- **Carga atual por técnico:** contagem por `assignee` e `status`, limitada a aberto/em andamento. Precisa de agregação/contrato e representação da equipe, sem novo campo; incluir técnicos com zero e separar não atribuídos/referências ausentes. Não comparar qualidade pelo número de chamados.
- **Entradas mensais:** contagem por `createdAt` em intervalo `[início, fim)`, com timezone definido. Precisa de nova consulta e parâmetros validados; não exige alteração de schema. Mede entradas, não backlog histórico.
- **Tempo de resolução e evolução do backlog:** dependem de definições sobre reabertura, primeira/última resolução e tempo corrido/útil. Não usar `updatedAt` como data de resolução. Eventos v2 registram transições e ciclos estruturados. Eventos legados ainda podem depender de frases incompletas; métricas históricas e sua cobertura não estão implementadas. Não disponíveis nesta versão.

Dados dos seeds são demonstrativos e não sustentam conclusões sobre uma operação real.

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

Não há cadastro público, recuperação de senha, administração de perfis na interface, comentários, anexos ou notificações. Dashboard não atualiza em tempo real e não possui filtro por período. Não há SLA nem ranking da equipe. O tema segue o sistema; não existe seletor manual.

O timeout de um E2E antigo permanece sem causa determinada; os scripts/registros daquela execução não estão disponíveis. O E2E atual é reproduzível e registra diagnóstico em falhas, mas uma execução aprovada não prova ausência de intermitência. Requisições do cliente de produção não possuem timeout explícito.
