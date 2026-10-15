# Checklist de demonstração e entrega

[Voltar ao README](../README.md) · [Fluxos e API](03-fluxos-e-api.md) · [Métricas e limites](04-metricas-decisoes-e-limites.md)

Evidências para acompanhar o roteiro: [login e operação por perfil](03-fluxos-e-api.md#capturas-por-perfil), [gestão, carga e gráficos](04-metricas-decisoes-e-limites.md#evidências-visuais) e [autoria no histórico](06-integridade-e-auditoria.md#evidência-visual-da-autoria).

## Preparação

- [ ] Docker Desktop iniciado (quando o MongoDB roda pelo Compose); API em `http://localhost:3000`; frontend em `http://localhost:5173`. Habilitar as configurações locais `DEMO_MODE=true` e `VITE_DEMO_MODE=true`, reiniciar os serviços e selecionar origem Demonstração para os exemplos.
- [ ] `.env` configurado conforme README, com JWT_SECRET preenchido e origens CORS corretas.
- [ ] `npm run seed` executado em backend; opcionalmente `npm run seed:demo` para exemplos e `npm run seed:incidents` para o incidente de demonstração.
- [ ] Credenciais dos três perfis disponíveis. Seed não muda senha/papel de um usuário existente.
- [ ] Executar os comandos de testes, typecheck, lint e builds do README.
- [ ] Deixar tempo para ensaiar e demonstrar persistência; evitar `docker compose down -v`, que apaga o volume.
- [ ] Não exibir JWT_SECRET, tokens, hashes ou credenciais reais em capturas ou terminal.

As caixas representam ações para a apresentação, não uma alegação de que todas já foram realizadas manualmente. Dados do seed são exemplos identificados como demonstração.

## Roteiro sugerido — cerca de 6 minutos

Use as três contas do README; o roteiro não depende de senhas adicionais. Na etapa 4, para demonstrar autoria diferente da atribuição, o Carlos (TI) pode atribuir à Ana (gestora), iniciar e resolver com a justificativa “Concluí o diagnóstico e validei o funcionamento com o solicitante”. A atribuição continua da Ana; a resolução pertence ao Carlos. Não confundir contas fictícias com usuários reais.

1. **Login e dashboard:** mostrar uma tentativa incorreta e depois entrar como solicitante. Explicar que o dashboard e a lista mostram só seus chamados. Não repetir muitas tentativas: o login tem limite por IP.
2. **Abertura:** clicar em **Solicitar suporte** e enviar o formulário vazio para mostrar validação. Criar “Projetor da sala 3 sem imagem”, descrição suficiente, tipo Hardware e prioridade sugerida Alta. A escolha de prioridade existe nesta versão; impacto ainda é uma proposta.
3. **Acompanhamento:** mostrar a confirmação na página do pedido, editar o texto enquanto aberto e consultar o evento no histórico. Anotar/copiar a URL do chamado para a demonstração de isolamento.
4. **Atendimento TI:** sair e entrar como TI. Localizar o chamado ainda aberto e sem responsável; escolher o usuário TI no seletor e salvar a atribuição. Ajustar categoria/prioridade, informar motivo da prioridade e salvar a classificação, iniciar atendimento e resolver. Mostrar os eventos. Opcionalmente, iniciar outro chamado sem responsável para mostrar a atribuição automática; reabertura também é opcional e exige motivo. Para resolução por outro responsável, informar justificativa e conferir as duas identidades.
5. **Retorno ao solicitante:** sair e entrar como solicitante. Mostrar o mesmo chamado atualizado e sem controles de triagem/status. Para isolamento, tentar a URL de um chamado aberto pela TI ou por outro solicitante: deve aparecer como não encontrado.
6. **Gestor:** entrar como gestor em Visão gerencial, selecionar Demonstração e comparar períodos. Mostrar os três alertas e abrir uma fila; comparar carga por prioridade e volume por solicitante, explicando que carga é atual e volume respeita o período de criação. Diferenciar carga atual de resoluções comprovadas por autor; mostrar operadores com zero, pendências sem responsável, solicitantes e horários. Abrir a fila de um operador, consultar histórico e retornar aos filtros. Mostrar que eventos legados não ganham autoria presumida. Menu Operação de chamados mantém atendimento completo; texto segue restrito aos próprios chamados abertos.
7. **Incidente compartilhado:** ver o roteiro na seção seguinte.
8. **Persistência:** recarregar a página e relogar, mostrando que o chamado e histórico permanecem. Para evidenciar MongoDB diretamente, usar a consulta abaixo; opcionalmente reiniciar apenas a API em ambiente de demonstração e repetir a consulta pela interface.

Com o banco padrão do `.env.example` e Docker Compose, na raiz do projeto, consulte o chamado criado mais recentemente e confira seu título:

```bash
docker compose exec mongo mongosh it-helpdesk --quiet --eval 'db.tickets.find({}, {title: 1, status: 1, requester: 1, assignee: 1, history: 1}).sort({createdAt: -1}).limit(1).toArray()'
```

Se o banco tiver outro nome ou for externo, consultar o banco definido em MONGODB_URI com a ferramenta disponível. Não imprimir a URI se tiver credenciais. A consulta é de leitura; não remove documentos.

## Roteiro do incidente compartilhado — cerca de 3 minutos

Com `npm run seed:demo` executado, rode em `backend`:

```bash
npm run seed:incidents
```

O script publica o incidente **Instabilidade na rede Wi-Fi** a partir do chamado de demonstração "Wi-Fi instável na sala de reuniões", usando as mesmas regras da aplicação. Se as contas adicionais `demo.solicitante2@helpdesk.local` e `demo.ti2@helpdesk.local` existirem, elas entram como afetadas; a Mariana fica de fora de propósito, para o clique ao vivo. Rodar de novo não duplica nada. Se o chamado estiver resolvido, o script avisa e não publica.

1. **Solicitante:** entrar como Mariana. Em Início, o cartão **Problemas conhecidos** mostra o incidente e o número de afetados. Clicar em **Também estou com esse problema**: o número sobe em um e o cartão confirma o acompanhamento. Recarregar a página e clicar de novo não aumenta a contagem. Abrir **Solicitar suporte** para mostrar o mesmo aviso antes do formulário.
2. **TI:** entrar como Carlos. Em Atendimento, **Incidentes ativos** traz o incidente com o novo total. Abrir o chamado: o bloco **Incidente compartilhado** mostra o texto público e os afetados. **Editar comunicação** altera a mensagem; o histórico do incidente registra quem alterou.
3. **Gestor:** entrar como Ana, selecionar origem **Demonstração** e mostrar o bloco **Incidentes compartilhados**: ativos, afetados e o incidente com link para o chamado.
4. **Encerramento:** como TI ou gestor, resolver o chamado principal (o gestor informa a justificativa, pois o responsável é o Carlos). O incidente é encerrado automaticamente. Como Mariana, o problema sai de Problemas conhecidos e aparece em **Problemas que você acompanhou** como resolvido.

Para repetir a demonstração, reabra o chamado (com motivo) e use **Republicar** no bloco do incidente: começa um novo ciclo e as pessoas confirmam de novo. Para começar um incidente do zero, publique a partir de outro chamado não resolvido com **Publicar como incidente**.

## O que os testes verificam

| Validação | Evidência disponível |
|---|---|
| Login, token e sessão | `auth.test.ts`; E2E testa senha incorreta, login/logout e restauração após reload |
| Criação e persistência | `tickets.test.ts` cria e consulta no MongoDB real; E2E edita um chamado pela UI e confirma na API |
| Isolamento e RBAC | `tickets.test.ts`, `permissions.test.ts` e `ticket-privacy.test.ts` (campos exatos e ausência de dados restritos nas respostas do solicitante); E2E compara acesso/listas dos três perfis e operações do gestor |
| Triagem, atribuição, resolução e reabertura | `tickets.test.ts`, incluindo eventos e transições |
| Dashboard | `dashboard.test.ts`, `permissions.test.ts` e `manager.test.ts`; períodos/fuso, ranking, autor real, ciclos, origens e acesso exclusivo; E2E verifica filtros e três reloads do básico por perfil |
| Rate limit e hardening | `security.test.ts`, incluindo 429, isolamento de outras rotas, ausência de X-Powered-By e limite JSON |
| Incidentes compartilhados | `incidents.test.ts` (27 testes): permissões, formato público, participação idempotente e simultânea, concorrência, encerramento, reconciliação (inclusive com falha de gravação simulada e reabertura antes da leitura), corridas entre publicação/republicação e resolução, reabertura e republicação; E2E: TI publica pela UI, marca na fila, solicitante entra/sai/volta com contagem exata, gestor vê o impacto, resolução encerra para todos |
| Mobile | E2E verifica dashboard gerencial em desktop/390 px (inclusive com tabela de incidentes), Início do solicitante em 390 px, capturas claro/escuro e contraste de texto dos botões; não substitui auditoria completa de acessibilidade/responsividade |

O E2E não automatiza toda a abertura e resolução pela UI. A integração cobre essas regras na API; o roteiro acima orienta a conferência visual manual.

## Registro da verificação documental

Em **15/10/2026**, na branch de incidentes compartilhados: **156 testes backend** e **115 verificações E2E** aprovados; typecheck, lint sem warnings e builds dos dois projetos aprovados. O verificador documental aprovou sete arquivos Markdown, 14 capturas PNG e as 15 variáveis dos exemplos, preservando as seis credenciais públicas. Os quatro diagramas Mermaid foram revisados manualmente contra a implementação; o diagrama de coleções inclui as duas coleções de incidentes.

Em **10/10/2026**, na etapa anterior: 124 testes backend e 104 verificações E2E aprovados.

A primeira tentativa E2E terminou com `Browser debugging connection closed` antes de qualquer verificação e sem requisições registradas. A repetição com permissão para executar o navegador fora do sandbox passou integralmente. Isso aponta para infraestrutura de execução; os registros não determinam a causa exata do encerramento nem provam ausência de intermitência. O teste e o código de produto não foram alterados para contornar a falha.

As capturas autenticaram os três perfis e consultaram páginas iniciais, lista e histórico sem alterar chamados ou usuários; a única escrita foi entrar e sair do incidente de demonstração com a conta da Mariana. O banco local manteve cinco usuários e 64 chamados, todos identificados como demonstração, e um incidente de demonstração ativo. Esses resultados são um registro desta execução, não substituem rodar os comandos na máquina do avaliador.

## Teste rápido da visão gerencial

1. Entrar com gestor e selecionar **Origem dos dados → Demonstração**. A instalação nova começa com os três perfis e exemplos do seed básico. O conjunto ampliado é opcional e exige as duas contas adicionais preexistentes. Nas capturas de 10/10/2026 havia cinco usuários e 64 chamados fictícios; esse total não é requisito nem garantia do seed.
2. Comparar Hoje, Últimos sete dias, Mês atual e Ano atual. Expandir filtros de equipe/classificação, selecionar um analista e depois um solicitante. Observar a definição de cada filtro na tela.
3. Conferir equipe, pendências sem responsável, ranking e horários. Resolver um chamado de outro operador requer motivo e deve creditar o autor real. Reabrir preserva sua resolução no período; outra resolução conta outro ciclo.
4. Abrir a fila do operador, entrar no detalhe e voltar: filtros da fila devem permanecer. Login TI/solicitante não mostra nem permite a visão gerencial.
5. Se os exemplos antigos não têm eventos v2 de resolução, o indicador comprovado pode ser zero. Conferir o alerta de cobertura e o histórico; não reconstruir produtividade fictícia.

## Repositório e avaliador

Verificação por leitura na API do GitHub em **09/10/2026**, durante a preparação desta entrega:

- `FIDEL7Z/it-helpdesk`: **privado**, confirmado pelo campo `private`.
- Consulta de colaborador para `ednaldotaurino`: HTTP 404; acesso ativo não confirmado.
- Lista de convites: **convite pendente encontrado para `EdnaldoTaurino`** (capitalização retornada pelo GitHub).

O convite pendente não equivale a acesso ativo. O avaliador precisa aceitá-lo. Conferir novamente em **Settings → Collaborators** antes da entrega e confirmar que a conta consegue abrir o repositório. Esta etapa não enviou nem reenviou convites e não alterou permissões.

- [ ] Confirmar aceitação do convite pelo avaliador.
- [x] Texto em primeira pessoa revisado e confirmado pelo autor.
- [x] Publicação da etapa documental anterior autorizada pelo autor.
- [ ] Integração e publicação da branch atual: dependem de nova autorização. A presente preparação não faz merge nem push.

## Solução de problemas

- **Testes ou API sem conexão com o banco:** com MongoDB pelo Compose, iniciar o Docker Desktop e executar `docker compose up -d --wait` na raiz antes de subir a API ou rodar `npm test`.
- **Porta 27017 em uso:** verificar se já há MongoDB disponível e ajustar a conexão se necessário.
- **Incidente não aparece:** executar `npm run seed:incidents` em `backend` após `npm run seed:demo`; se o chamado de Wi-Fi já estiver resolvido, reabri-lo e republicar pelo bloco do incidente.
- **Invalid environment variables:** conferir MONGODB_URI e JWT_SECRET com ao menos 32 caracteres.
- **Failed to start server:** verificar conexão com o banco; a API só aceita requisições depois de conectar.
- **EBADENGINE:** usar Node 22.22 ou superior, conforme engines dos projetos.
- **429 no login:** aguardar a janela do limite; reiniciar a API apenas no ambiente de demonstração se necessário.
- **CORS:** conferir origem exata, inclusive porta; preview usa 4173, desenvolvimento usa 5173 por padrão.
- **Seed demo sem usuários:** executar `npm run seed` no mesmo ambiente antes de `npm run seed:demo`.

## Seed gerencial local

O comando `npm run seed:manager`, no backend, exige `LOCAL_DEMO_SEED=1`, ambiente diferente de produção e URI MongoDB loopback com banco `it-helpdesk`. Não aceita MongoDB remoto ou outro banco; não imprime a URI. Requer duas contas solicitantes, duas TI e uma gestora, das identidades fictícias reservadas: os três perfis do README e `demo.ti2@helpdesk.local` / `demo.solicitante2@helpdesk.local`. Não cria contas nem publica senhas adicionais. As credenciais adicionais do ambiente de apresentação devem ser consultadas localmente com o responsável.

O seed cria 24 chamados novos por mês local, identificados por `[DEMO GERENCIAL v1]`, descrição fictícia e `dataOrigin=demo`. IDs derivam da versão do conjunto, mês e posição; uma execução posterior no mesmo mês preserva documentos já criados, inclusive se modificados manualmente. Colisões com registros que não pertencem ao conjunto interrompem a execução. Operações fictícias têm autores/snapshots, datas ordenadas e passadas, revisões incrementais, ciclos, responsáveis e projeções de resolução consistentes. Todas pertencem a exemplos novos; registros antigos nunca recebem autoria retroativa.

Horários variam entre 8h e 16h no mês atual e no fuso configurado. No primeiro dia, horários ainda futuros são limitados ao passado disponível; no primeiro minuto do mês o script interrompe. A versão atual não corrige/amplia exemplos já existentes no mesmo mês; um mês posterior cria um novo conjunto, sem apagar os anteriores.

Para conferir a central gerencial, habilite as duas configurações demo, entre como gestor e acesse `/manager?dataOrigin=demo`. Verifique os três alertas, a carga por prioridade, as resoluções por autor e o retorno dos links ao histórico. Inatividade sem autoria comprovada é informada separadamente; quantidade de resoluções não avalia qualidade da equipe. Selecione dados operacionais para confirmar que a demonstração não entra no indicador real.

Os testes gerenciais validam seed idempotente, preservação de documentos anteriores, integridade dos ciclos e separação de origem em banco temporário. O E2E usa outro banco isolado, sem executar o seed contra o ambiente de apresentação.

## Capturas reproduzíveis

As 14 imagens em [assets/screenshots](assets/screenshots) foram obtidas na aplicação real, sem montagem ou substituição de valores. Desktop usa viewport 1440 × 900 e mobile 390 × 844, tema claro. As páginas iniciais dos três perfis, a do solicitante no celular e o gestor mobile usam captura de página inteira; sua altura PNG é maior que a viewport. [capture-info.json](assets/screenshots/capture-info.json) registra rotas, viewports, origem, instante, dimensões da imagem, título, cabeçalho e identidade pública do usuário autenticado, confirmada em `/auth/me`. A rota de detalhe identifica um registro fictício; não é uma credencial.

Para conferir somente a documentação, em `backend`:

```bash
npm run docs:check
```

Para refazer as capturas, mantenha MongoDB, API e frontend locais executando, habilite as duas opções demo e use o conjunto ampliado já preparado. São necessários um chamado estruturado resolvido por outro responsável, criado pelo seed gerencial, e um incidente ativo, criado por `npm run seed:incidents`. O seed inicial sozinho não oferece esse cenário pronto. As capturas publicadas podem ser consultadas sem executar o script.

```bash
# Em backend, com a aplicação disponível em localhost:3000 e localhost:5173
npm run docs:capture
```

O script usa Edge/Chrome headless instalado, Node/WebSocket e um perfil temporário próprio, sem dependências novas. Autentica exclusivamente as três identidades fictícias reservadas; lê credenciais locais SEED quando presentes, senão os valores públicos do README. Não grava tokens, senhas ou respostas de autenticação em arquivos. Não abre, edita ou resolve chamados. Para mostrar o acompanhamento, a Mariana entra no incidente de demonstração e sai logo depois da captura, voltando ao estado anterior; essa entrada passa a contar em "Novas adesões (30 dias)" da origem demonstração. Ao final, encerra seu navegador e remove seu perfil temporário; os serviços permanecem disponíveis.

A captura aguarda dados e gráficos renderizados e rejeita estados visíveis de erro, modal ou carregamento. Não execute em produção. Respeite o limite de dez logins por IP em quinze minutos ao repetir. Se necessário, defina E2E_BROWSER_PATH com o executável local. A ferramenta substitui as imagens da documentação; revise-as antes de qualquer commit.

O README apresenta as páginas iniciais dos três perfis e o incidente. As demais imagens ficam nos documentos técnicos.

Para refazer somente as três páginas iniciais e o gestor mobile, mantendo as outras evidências:

```bash
npm run docs:capture -- --profiles-only
```

Antes de cada captura de página inicial, o script confere perfil em `/auth/me`, identidade no cabeçalho, URL, título e cabeçalho da página. Compara totais e escopo com a API; na TI confere a fila pessoal, no solicitante confere o problema conhecido e o botão Solicitar suporte. Na gestão, aguarda os quatro gráficos. As imagens são inspecionadas visualmente antes da publicação; dados não são modificados para melhorar a apresentação.
