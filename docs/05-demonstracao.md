# Checklist de demonstração e entrega

[Voltar ao README](../README.md) · [Fluxos e API](03-fluxos-e-api.md) · [Métricas e limites](04-metricas-decisoes-e-limites.md)

## Preparação

- [ ] MongoDB disponível; API em `http://localhost:3000`; frontend em `http://localhost:5173`.
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
4. **Atendimento TI:** sair e entrar como TI. Localizar o chamado ainda aberto e sem responsável; escolher o usuário TI no seletor e salvar a atribuição. Ajustar categoria/prioridade, salvar a classificação, iniciar atendimento e resolver. Mostrar os eventos. Opcionalmente, iniciar outro chamado sem responsável para mostrar a atribuição automática; reabertura também é opcional.
5. **Retorno ao solicitante:** sair e entrar como solicitante. Mostrar o mesmo chamado atualizado e sem controles de triagem/status. Para isolamento, tentar a URL de um chamado aberto pela TI ou por outro solicitante: deve aparecer como não encontrado.
6. **Gestor:** entrar como gestor; mostrar dashboard global, chamado da outra pessoa e ausência dos controles de atendimento. Explicar que pode abrir/editar os próprios chamados abertos, mas não assumir atendimento.
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
| Isolamento e RBAC | `tickets.test.ts` e `permissions.test.ts`; E2E compara acesso/listas dos três perfis e bloqueios do gestor |
| Triagem, atribuição, resolução e reabertura | `tickets.test.ts`, incluindo eventos e transições |
| Dashboard | `dashboard.test.ts` e `permissions.test.ts`; E2E verifica contagens e três reloads por perfil |
| Rate limit e hardening | `security.test.ts`, incluindo 429, isolamento de outras rotas, ausência de X-Powered-By e limite JSON |
| Mobile | E2E verifica largura do dashboard do gestor em 390 px; não substitui auditoria completa de acessibilidade/responsividade |

O E2E não automatiza toda a abertura e resolução pela UI. A integração cobre essas regras na API; o roteiro acima orienta a conferência visual manual.

## Repositório e avaliador

Verificação por leitura na API do GitHub em **09/10/2026**, durante a preparação desta entrega:

- `FIDEL7Z/it-helpdesk`: **privado**, confirmado pelo campo `private`.
- Consulta de colaborador para `ednaldotaurino`: HTTP 404; acesso ativo não confirmado.
- Lista de convites: **convite pendente encontrado para `EdnaldoTaurino`** (capitalização retornada pelo GitHub).

O convite pendente não equivale a acesso ativo. O avaliador precisa aceitá-lo. Conferir novamente em **Settings → Collaborators** antes da entrega e confirmar que a conta consegue abrir o repositório. Esta etapa não enviou nem reenviou convites e não alterou permissões.

- [ ] Confirmar aceitação do convite pelo avaliador.
- [ ] Revisar/aprovar o rascunho em primeira pessoa.
- [ ] Autorizar separadamente merge e publicação da branch documental, caso aprovada.

## Solução de problemas

- **Porta 27017 em uso:** verificar se já há MongoDB disponível e ajustar a conexão se necessário.
- **Invalid environment variables:** conferir MONGODB_URI e JWT_SECRET com ao menos 32 caracteres.
- **Failed to start server:** verificar conexão com o banco; a API só aceita requisições depois de conectar.
- **EBADENGINE:** usar Node 22.22 ou superior, conforme engines dos projetos.
- **429 no login:** aguardar a janela do limite; reiniciar a API apenas no ambiente de demonstração se necessário.
- **CORS:** conferir origem exata, inclusive porta; preview usa 4173, desenvolvimento usa 5173 por padrão.
- **Seed demo sem usuários:** executar `npm run seed` no mesmo ambiente antes de `npm run seed:demo`.
