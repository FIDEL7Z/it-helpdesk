# Checklist de demonstração e entrega

[Voltar ao README](../README.md) · [Fluxos e API](03-fluxos-e-api.md) · [Métricas e limites](04-metricas-decisoes-e-limites.md)

## Preparação

- [ ] MongoDB disponível; API em `http://localhost:3000`; frontend em `http://localhost:5173`. Habilitar as configurações locais `DEMO_MODE=true` e `VITE_DEMO_MODE=true`, reiniciar os serviços e selecionar origem Demonstração para os exemplos.
- [ ] `.env` configurado conforme README, com JWT_SECRET preenchido e origens CORS corretas.
- [ ] `npm run seed` executado em backend; opcionalmente `npm run seed:demo` para exemplos.
- [ ] Credenciais dos três perfis disponíveis. Seed não muda senha/papel de um usuário existente.
- [ ] Executar os comandos de testes, typecheck, lint e builds do README.
- [ ] Deixar tempo para ensaiar e demonstrar persistência; evitar `docker compose down -v`, que apaga o volume.
- [ ] Não exibir JWT_SECRET, tokens, hashes ou credenciais reais em capturas ou terminal.

As caixas representam ações para a apresentação, não uma alegação de que todas já foram realizadas manualmente. Dados do seed são exemplos identificados como demonstração.

## Roteiro sugerido — cerca de 6 minutos

1. **Login e dashboard:** mostrar uma tentativa incorreta e depois entrar como solicitante. Explicar que o dashboard e a lista mostram só seus chamados. Não repetir muitas tentativas: o login tem limite por IP.
2. **Abertura:** enviar o formulário vazio para mostrar validação. Criar “Projetor da sala 3 sem imagem”, descrição suficiente, categoria Hardware e prioridade Alta. A escolha de prioridade existe nesta versão; impacto ainda é uma proposta.
3. **Acompanhamento:** mostrar confirmação na lista, abrir o detalhe, editar o texto enquanto aberto e consultar o evento no histórico. Anotar/copiar a URL do chamado para a demonstração de isolamento.
4. **Atendimento TI:** sair e entrar como TI. Localizar o chamado ainda aberto e sem responsável; escolher o usuário TI no seletor e salvar a atribuição. Ajustar categoria/prioridade, informar motivo da prioridade e salvar a classificação, iniciar atendimento e resolver. Mostrar os eventos. Opcionalmente, iniciar outro chamado sem responsável para mostrar a atribuição automática; reabertura também é opcional e exige motivo. Para resolução por outro responsável, informar justificativa e conferir as duas identidades.
5. **Retorno ao solicitante:** sair e entrar como solicitante. Mostrar o mesmo chamado atualizado e sem controles de triagem/status. Para isolamento, tentar a URL de um chamado aberto pela TI ou por outro solicitante: deve aparecer como não encontrado.
6. **Gestor:** entrar como gestor em Visão gerencial, selecionar Demonstração e comparar períodos. Diferenciar carga atual de resoluções comprovadas por autor; mostrar operadores com zero, pendências sem responsável, solicitantes e horários. Abrir a fila de um operador, consultar histórico e retornar aos filtros. Mostrar que eventos legados não ganham autoria presumida. Menu Operação de chamados mantém atendimento completo; texto segue restrito aos próprios chamados abertos.
7. **Persistência:** recarregar a página e relogar, mostrando que o chamado e histórico permanecem. Para evidenciar MongoDB diretamente, usar a consulta abaixo; opcionalmente reiniciar apenas a API em ambiente de demonstração e repetir a consulta pela interface.

Com o banco padrão do `.env.example` e Docker Compose, na raiz do projeto, consulte o chamado criado mais recentemente e confira seu título:

```bash
docker compose exec mongo mongosh it-helpdesk --quiet --eval 'db.tickets.find({}, {title: 1, status: 1, requester: 1, assignee: 1, history: 1}).sort({createdAt: -1}).limit(1).toArray()'
```

Se o banco tiver outro nome ou for externo, consultar o banco definido em MONGODB_URI com a ferramenta disponível. Não imprimir a URI se tiver credenciais. A consulta é de leitura; não remove documentos.

## O que os testes verificam

| Validação | Evidência disponível |
|---|---|
| Login, token e sessão | `auth.test.ts`; E2E testa senha incorreta, login/logout e restauração após reload |
| Criação e persistência | `tickets.test.ts` cria e consulta no MongoDB real; E2E edita um chamado pela UI e confirma na API |
| Isolamento e RBAC | `tickets.test.ts` e `permissions.test.ts`; E2E compara acesso/listas dos três perfis e operações do gestor |
| Triagem, atribuição, resolução e reabertura | `tickets.test.ts`, incluindo eventos e transições |
| Dashboard | `dashboard.test.ts`, `permissions.test.ts` e `manager.test.ts`; períodos/fuso, ranking, autor real, ciclos, origens e acesso exclusivo; E2E verifica filtros e três reloads do básico por perfil |
| Rate limit e hardening | `security.test.ts`, incluindo 429, isolamento de outras rotas, ausência de X-Powered-By e limite JSON |
| Mobile | E2E verifica dashboard gerencial em desktop/390 px, capturas claro/escuro e contraste de texto dos botões; não substitui auditoria completa de acessibilidade/responsividade |

O E2E não automatiza toda a abertura e resolução pela UI. A integração cobre essas regras na API; o roteiro acima orienta a conferência visual manual.

## Teste rápido da visão gerencial

1. Entrar com gestor e selecionar **Origem dos dados → Demonstração**. O ambiente local ampliado preserva seus cinco usuários e 40 chamados; instalação nova depende dos exemplos disponíveis no seed.
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
- [x] Merge e publicação da documentação autorizados pelo autor.

## Solução de problemas

- **Porta 27017 em uso:** verificar se já há MongoDB disponível e ajustar a conexão se necessário.
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
