# IT Helpdesk

Central de suporte interno de TI: quem precisa de ajuda encontra uma solução ou abre um pedido, a equipe de TI atende pela lista ou pelo quadro, e a gestão acompanha a operação e a qualidade do atendimento.

[Como executar](#instalação) · [Usuários demonstrativos](#usuários-demonstrativos) · [Testes](#testes) · [Documentação](#documentação-complementar)

## O problema

A equipe de TI fica sobrecarregada: pedidos chegam por vários canais, muitos têm solução simples, problemas coletivos geram dezenas de chamados iguais, e ninguém sabe ao certo se o que foi resolvido funcionou. O IT Helpdesk ataca os três pontos: evita pedidos desnecessários (orientações e problemas conhecidos antes de abrir um pedido), organiza os que chegam (assunto e perguntas certas desde o início, fila e quadro) e acompanha a qualidade (o solicitante confirma ou contesta cada resolução).

## Principais funcionalidades

- **Portal do Solicitante:** busca de soluções, assuntos, problemas conhecidos, pedido guiado e acompanhamento em linguagem simples.
- **Incidentes Compartilhados:** a TI avisa todos de uma vez; quem está afetado diz "também estou com esse problema" sem abrir outro pedido.
- **Base de Conhecimento:** artigos de ajuda escritos pela equipe, com busca e "a orientação ajudou?".
- **Classificação orientada:** "Com o que você precisa de ajuda?" leva à categoria técnica e a perguntas curtas sobre o assunto.
- **Confirmação de resolução:** "Seu problema foi resolvido?", com contestação que reabre o pedido e avaliação opcional.
- **Kanban:** a fila da TI em **Lista** ou **Quadro**, com os mesmos filtros e regras.
- **Estoque e Patrimônio:** departamentos e salas, materiais por quantidade e equipamentos por número de patrimônio, cada entrada, entrega, troca e transferência registrada e ligada ao chamado.
- **Notificações por e-mail:** o solicitante recebe avisos do próprio pedido (registro, início, resolução que pede confirmação, reabertura e material entregue), no e-mail confirmado da conta, com preferências em **Minha conta**. Testável sem conta externa, numa caixa local (Mailpit).
- **Assistente:** um chat consultivo em todas as páginas responde com o que cada perfil já pode ver (artigos, problemas conhecidos, chamados, estoque e indicadores), citando as fontes. Usa IA generativa (Cloudflare Workers AI) quando configurada; sem ela, responde em um modo demonstrativo identificado.
- **Visão gerencial:** alertas, carga da equipe, resoluções comprovadas por autor, incidentes e qualidade do atendimento.
- **Base comum:** permissões por perfil no backend, histórico auditável com revisão e ciclos, identidade visual com tokens centralizados, tema claro por padrão e botão **Tema escuro** no cabeçalho (escolha guardada no navegador), contraste AA nos dois temas e layout para celular.

Regras detalhadas em [produto e regras](docs/01-produto-e-regras.md); passo a passo de cada perfil em [como usar, por perfil](docs/03-fluxos-e-api.md#como-usar-por-perfil).

## Portal do Solicitante

A página Início é um portal de ajuda: **Como podemos ajudar?**, uma busca larga por orientações e um único botão **Solicitar suporte**. Abaixo, os cinco assuntos em cartões (ícone, título, descrição e seta) levam direto ao pedido guiado; os **Problemas conhecidos** ficam numa faixa própria, só quando existem; por fim, **Meus pedidos** mostra os pedidos mais recentes. Pesquisar não é obrigatório.

![Página Início da solicitante com busca de soluções, assuntos, problema conhecido e Meus pedidos](docs/assets/screenshots/dashboard-solicitante-desktop.png)

Os pedidos aparecem como Aguardando atendimento, Em atendimento ou Resolvido; o que espera a resposta do solicitante tem a marca **Confirme se resolveu**. A tela não mostra indicadores da equipe, tabelas administrativas nem termos técnicos. A **Central de ajuda** separa buscar e ler orientações; abrir um pedido continua a um clique, mas não compete com a busca.

## Incidentes Compartilhados

Quando um problema atinge várias pessoas, a TI publica um aviso a partir do chamado principal. Quem também está afetado clica em **Também estou com esse problema**; a equipe vê quantas pessoas foram atingidas e, ao resolver o chamado, o aviso é encerrado para todos.

- O solicitante recebe só o texto público escrito pela TI; descrição do chamado e lista de afetados não saem do backend.
- Repetir o clique, ou muitas pessoas ao mesmo tempo, não duplica a contagem nem interfere no atendimento.
- Um incidente nunca aparece como ativo depois que o chamado principal foi resolvido, mesmo se a gravação do encerramento falhar.
- O número de afetados mostra alcance; o sistema não afirma quantos chamados foram evitados.

## Base de Conhecimento

TI e gestor escrevem artigos em **Artigos** (`/help/manage`), uma página de gestão separada da Central de ajuda, com abas Publicados, Rascunhos, Arquivados e Todos, e ações Editar e Ver. O solicitante pesquisa por palavras do título ou do conteúdo, sem precisar acertar acentos, ou filtra por assunto. Em cada artigo responde **Isso resolveu meu problema.** ou **Ainda preciso de ajuda.**; a segunda opção abre o pedido com o assunto e o artigo já indicados, que podem ser removidos. Nada é criado automaticamente.

O texto dos artigos é exibido somente como texto: HTML ou scripts digitados não são executados. Cada pessoa tem um único voto por artigo, que pode trocar; os totais aparecem só para a equipe.

## Classificação orientada

O pedido começa com **Com o que você precisa de ajuda?**: Computador ou equipamento, Internet e conexão, Programas e aplicativos, Contas e permissões ou Outro problema. Cada opção corresponde a uma categoria técnica já existente. Em seguida aparecem os problemas conhecidos e as orientações do assunto, e até três perguntas curtas e opcionais (por exemplo, "O problema acontece no Wi-Fi ou na conexão por cabo?").

As respostas ficam num campo próprio, separado da descrição escrita pela pessoa, e aparecem para a TI em **Informações do pedido**. A categoria pode ser corrigida pela TI (com auditoria) e o assunto nunca define a prioridade. As perguntas nunca pedem senhas, códigos ou tokens.

## Confirmação de resolução

Quando a TI resolve, o solicitante vê **Seu problema foi resolvido?**. "Sim" confirma e oferece uma avaliação opcional de 1 a 5 estrelas; "Não, o problema continua" pede o motivo e reabre o pedido num novo ciclo, preservando a resolução anterior e quem a fez. A fila da TI mostra **Reaberto pelo solicitante**.

Só o dono do pedido responde, uma vez por resolução; a equipe não responde por ele. A visão gerencial mostra confirmadas, contestadas, sem resposta, taxa de resposta e nota média sobre as resoluções do período. Sem nota não significa nota ruim.

## Kanban

TI e gestor alternam a fila entre **Lista** e **Quadro** (Abertos, Em andamento, Resolvidos). Um painel único reúne a forma de exibição, as **filas rápidas** (Sem responsável, Atribuídos a mim, Em andamento, Reabertos pelo solicitante) e a busca com filtros; no celular os filtros começam recolhidos atrás de **Filtros**, com a contagem dos ativos. O quadro ocupa toda a largura, inclusive quando um filtro de status deixa uma só coluna. Ele usa os mesmos filtros (guardados na URL) e a mesma API da lista, carrega 20 cartões por coluna e mostra "carregados de total". As ações são botões nos cartões (Assumir, Iniciar atendimento, Resolver), acessíveis por teclado e sujeitos às mesmas regras: justificativa para resolver chamado de outro responsável, conflito 409 com dados antigos e auditoria. Não há arrastar e soltar.

## Estoque e Patrimônio

Maria, do Financeiro, sala 203, abre um chamado porque o teclado parou. No próprio chamado, a TI vê quantos teclados há, entrega um Logitech K120 e registra o teclado velho como defeituoso. O saldo cai exatamente uma unidade, o chamado mostra quem entregou, quem recebeu, onde e por quê, e a gestão vê o consumo por material e por departamento.

![Chamado com a seção Materiais e equipamentos: entrega de um teclado e devolução do antigo com defeito](docs/assets/screenshots/chamado-entrega-material-desktop.png)

- **Dois modos de controle:** por quantidade (teclados, mouses, cabos) ou por patrimônio, com número único por equipamento (notebooks, monitores, computadores), que tem situação, local e responsável.
- **Movimentações auditáveis:** entrada, reserva, entrega, devolução, transferência, manutenção, defeito e, com permissão da gestão e motivo, ajuste, descarte, estorno e baixa. Nada é editado ou apagado: correções são estornos.
- **Saldo seguro:** nunca fica negativo, duas retiradas simultâneas do último item resultam em uma entrega e uma recusa, e repetir a mesma requisição não retira outra unidade.
- **Separado do atendimento:** entregar material não resolve o chamado, e resolver não dá baixa no estoque.
- **Solicitante:** informa onde está o problema e vê só o que foi entregue no próprio pedido, sem acesso ao estoque.

Regras em [produto e regras](docs/01-produto-e-regras.md#estoque-e-patrimônio); como a consistência é garantida sem transações, em [arquitetura e dados](docs/02-arquitetura-e-dados.md#estoque-patrimônio-e-livro-razão).

## Notificações por e-mail

O solicitante recebe um e-mail quando o pedido é registrado, quando o atendimento começa, quando a TI o marca como resolvido (pedindo a confirmação), quando a TI o reabre e quando um material ou equipamento é entregue no pedido. Edições, atribuições e as respostas do próprio solicitante não geram e-mail.

- **Destinatário:** sempre o dono do pedido, com o e-mail **confirmado** da conta. Nenhuma rota aceita um endereço vindo da tela.
- **Conteúdo:** o e-mail mostra só o que a pessoa já vê no pedido: assunto, referência, data e o link para a página, que continua exigindo login. Justificativas da equipe e anotações internas não entram.
- **Minha conta:** clique no seu nome no cabeçalho (no celular, no ícone de pessoa). A página mostra o e-mail, permite confirmá-lo, trocá-lo (com a senha atual; o novo endereço só vale depois de confirmado), ligar ou desligar os avisos opcionais e ver o estado real dos últimos avisos. "Na fila" não aparece como "enviado".
- **Nunca trava o atendimento:** o pedido é salvo primeiro, e o envio acontece em segundo plano, com novas tentativas e recuperação após reinício. Com o provedor fora do ar, o chamado continua sendo criado normalmente.

### Testar sem conta externa (Mailpit)

O `docker compose up -d --wait` também sobe o **Mailpit**, uma caixa de e-mail local em **http://localhost:8025**: nenhuma mensagem sai do computador, seja qual for o endereço.

1. Em `backend/.env`, mude `EMAIL_ENABLED=true` (o `EMAIL_PROVIDER` de exemplo já é `mailpit`) e reinicie a API.
2. Entre como Mariana (solicitante), abra **Minha conta** e clique em **Enviar e-mail de confirmação**.
3. Em http://localhost:8025, abra a mensagem "Confirme seu e-mail", clique em **Confirmar e-mail** e, na página que abrir, em **Confirmar este e-mail**.
4. Abra um pedido: em poucos segundos chega "Recebemos seu pedido". Entre como Carlos (TI), inicie, entregue um material e resolva o pedido: cada etapa gera um e-mail na mesma caixa.

### Envio real (Resend)

Com uma conta no [Resend](https://resend.com), uma chave de API e um remetente num domínio verificado lá:

```bash
EMAIL_ENABLED=true
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_sua_chave
EMAIL_FROM=IT Helpdesk <helpdesk@seu-dominio-verificado.com>
EMAIL_RECIPIENT_ALLOWLIST=voce@empresa.com
```

Fora de produção, o Resend e o Gmail só enviam para endereços (ou `@domínios`) da `EMAIL_RECIPIENT_ALLOWLIST`; os outros ficam registrados como "não enviado". As contas de demonstração (`@helpdesk.local`) nunca recebem por um provedor real. A chave fica só no `.env` do backend, nunca no repositório nem no navegador. Detalhes e limites em [decisões e limitações](docs/04-metricas-decisoes-e-limites.md#notificações-por-e-mail).

### Envio real pelo Gmail (opcional)

Para demonstrar um e-mail chegando de verdade, sem domínio próprio. Uma conta Gmail é configurada uma única vez como remetente; nenhum outro usuário entra com conta Google.

1. Na conta Google remetente, ative a **verificação em duas etapas** e crie uma **senha de app** em https://myaccount.google.com/apppasswords. São 16 letras; os espaços que o Google mostra podem ficar.
2. Em `backend/.env`:

   ```bash
   EMAIL_ENABLED=true
   EMAIL_PROVIDER=gmail
   GMAIL_USER=remetente@gmail.com
   GMAIL_APP_PASSWORD=sua senha de app
   EMAIL_RECIPIENT_ALLOWLIST=quem-vai-receber@gmail.com
   ```

3. Reinicie a API. A pessoa que vai receber confirma o e-mail em **Minha conta** e abre um pedido. Quando a TI resolve, chega "Seu pedido foi resolvido: confirme se deu certo", com o link para confirmar ou contestar no sistema.

O e-mail sai sempre do endereço `GMAIL_USER`, com o nome dado em `EMAIL_FROM`. A senha de app fica só no `.env` local, que não é versionado, e pode ser revogada na mesma página do Google. A confirmação do e-mail também é enviada pelo Gmail; para testar o envio real com um único e-mail, confirme antes pelo Mailpit ou desligue os avisos opcionais em **Minha conta**.

## Assistente

O botão **Assistente**, no canto inferior direito de todas as páginas, abre um chat consultivo. Ele responde com o que a pessoa já pode ver no sistema e cita as fontes, com links para as páginas que as mostram.

| Perfil | O que o assistente pode usar |
|---|---|
| Solicitante | Artigos publicados, problemas conhecidos e os próprios pedidos |
| TI | Os mesmos, os chamados da equipe e o saldo do estoque |
| Gestor | Tudo acima, mais consumo de materiais por setor, situação dos chamados, equipe e qualidade |

- **Quem decide é o backend.** Ele confere o JWT e as permissões e lê os dados pelos mesmos serviços das páginas. A pergunta só escolhe o que é relevante entre o que já é permitido; pedir no chat não libera nada.
- **A IA não acessa o banco.** O modelo recebe apenas a pergunta e até 8 trechos curtos já autorizados, e citações de fontes que não foram enviadas são descartadas.
- **É só consultivo.** O assistente não altera chamados nem estoque; ele aponta a página onde a ação é feita. A conversa não é guardada.
- **Limite:** 20 perguntas por pessoa a cada 10 minutos.

**Sem configuração** (o padrão), o assistente funciona em **modo demonstrativo**: sem IA generativa, ele lista as informações encontradas para o perfil, com um aviso claro. Se o serviço de IA configurado falhar, a resposta também cai nesse modo, e o resto do Helpdesk segue normal. O aviso diz o motivo: IA desligada, cota diária gratuita esgotada, chave inválida ou vencida, muitas perguntas no minuto, ou IA indisponível.

Cada resposta mostra a sua origem logo abaixo do texto: **"Resposta da IA · nome do modelo"** ou **"Modo demonstrativo · sem IA"**. Uma resposta demonstrativa nunca aparece como se fosse da IA.

**Com IA real**, as respostas vêm de um modelo do Cloudflare Workers AI, no plano gratuito, por meio do serviço em `ai-worker/`. Quem avalia não instala modelo nem conhece as credenciais da Cloudflare.

### Testar a IA real numa instalação local

1. Peça ao dono um acesso temporário. Ele gera uma chave **só sua**, com validade curta (alguns dias), e envia o endereço e a chave por um canal privado.
2. Coloque os dois em `backend/.env` e reinicie o backend:

   ```bash
   AI_WORKER_URL=https://endereco-do-servico.workers.dev
   AI_WORKER_KEY=chave-recebida-do-dono
   ```

3. Abra o **Assistente** com cada perfil. Perguntas de exemplo: "Meu teclado parou de funcionar. Como solicito suporte?" (solicitante), "Temos teclados disponíveis para atender um chamado?" (TI) e "Quais departamentos mais consumiram periféricos?" (gestor). Para ver origem, latência, tokens e fontes de uma vez: `cd backend && node scripts/measure-assistant.mjs`.

Sobre essa chave:
- **Ela fica visível para você.** Como o backend roda no seu computador, a chave no `.env` pode ser lida por quem usa a máquina. Por isso ela é pessoal, vence sozinha, pode ser revogada a qualquer momento sem afetar outras pessoas e tem limite de uso.
- **Ela nunca vai para o repositório nem para o navegador.** Não há chave compartilhada no código; o React só fala com o backend.
- **Limites:** cerca de 10 respostas por minuto por chave (aproximado), 20 perguntas por pessoa a cada 10 minutos no backend e a cota gratuita diária da Cloudflare, que zera às 21h (horário de Brasília). Quando algo disso acaba, as respostas voltam ao modo demonstrativo com aviso, sem cobrança.

Sem a chave, tudo continua funcionando em modo demonstrativo. Como o serviço é publicado e protegido: [ai-worker/README.md](ai-worker/README.md).

## Os três perfis

Telas reais, com dados fictícios de demonstração. A página do solicitante está em [Portal do Solicitante](#portal-do-solicitante).

**Suporte TI (Carlos Andrade) — Atendimento.** Uma mesa de trabalho, não um painel: **Precisa de ação** (alta prioridade sem responsável, reabertos pelo solicitante, sem movimentação, sem responsável), **Meus atendimentos** e **Sem responsável**, ambos por prioridade e antiguidade, incidentes ativos e, por último, a situação da fila. Atalhos para a fila e o quadro.

![Página Atendimento da TI com cartões de ação, filas pessoal e sem responsável, incidente ativo e situação da fila](docs/assets/screenshots/dashboard-ti-desktop.png)

**Gestor (Ana Ribeiro) — Visão gerencial.** Seções na ordem das decisões: Situação atual, Precisa de atenção (com aviso de carga desigual), Equipe, Incidentes, Qualidade e Demanda e tendências. Período e origem dos dados ficam numa barra compacta; os demais filtros, em "Mais filtros". A operação (Atendimento, Chamados, Artigos) fica num grupo secundário do menu.

![Visão gerencial com situação atual, alertas, equipe, incidentes, qualidade e gráficos](docs/assets/screenshots/gestor-visao-geral-desktop.png)

Todas as telas da equipe começam com dados **operacionais**. Com o modo demonstração ligado, Demonstração, Legado ou Todas as origens são uma escolha explícita: aparece uma faixa fixa de aviso, e cada chamado fictício ou legado tem uma etiqueta na linha ou no cartão. Sem chamados operacionais, a página oferece **Ver dados de demonstração**, sem trocar sozinha; uma origem vazia é explicada ("os zeros indicam ausência de registros, não desempenho da equipe"). Fora do modo demonstração, e sempre em produção, a API só entrega dados operacionais. Veja a [política de origem](docs/04-metricas-decisoes-e-limites.md#origem-dos-dados).

As demais telas estão no [guia de demonstração](docs/05-demonstracao.md#capturas-reproduzíveis) e nos documentos técnicos.

## Stack

- **Frontend:** React 19, Vite 8, TypeScript, React Router 8, Recharts e CSS próprio com tokens de cor. Os gráficos adaptam os componentes de referência do shadcn/ui.
- **Backend:** Node.js, Express 5, TypeScript, Zod, JWT, bcryptjs e express-rate-limit.
- **Dados:** MongoDB 7 e Mongoose 9.
- **Ambiente local:** Docker Compose apenas para o MongoDB; API e frontend rodam com npm.
- **Testes:** node:test com Express e MongoDB reais, typecheck, oxlint, builds e E2E em Edge/Chrome headless sem biblioteca extra.

```mermaid
flowchart LR
  FRONT[React e Vite] -->|HTTP e JWT| API[API Express: validação e regras]
  API -->|Mongoose| MONGO[(MongoDB)]
```

Controllers validam a entrada; services aplicam escopo, propriedade e regras; models representam os documentos. Veja [arquitetura e dados](docs/02-arquitetura-e-dados.md).

## Requisitos

- Node.js **22.22 ou superior** e npm.
- Docker Desktop (ou Docker Engine) com Docker Compose, para o MongoDB local. Dispensável se houver outro MongoDB disponível; nesse caso ajuste `MONGODB_URI`.
- Edge ou Chrome instalado, apenas para o teste E2E e as capturas.
- Portas livres: 27017 (MongoDB), 8025 (caixa de e-mail local Mailpit), 3000 (API) e 5173 (interface).

> **Se a execução local utilizar Docker para o MongoDB, é necessário iniciar o Docker Desktop antes de subir os serviços ou executar testes de integração.**

## Instalação

Os comandos usam `cp`, disponível no Git Bash/macOS/Linux e como alias no PowerShell (onde também vale `Copy-Item`). Se o PowerShell bloquear `npm.ps1`, use `npm.cmd` no lugar de `npm`, sem alterar a política de execução.

```bash
git clone https://github.com/FIDEL7Z/it-helpdesk.git
cd it-helpdesk
docker compose up -d --wait

cd backend
npm ci
cp .env.example .env

cd ../frontend
npm ci
cp .env.example .env
```

O repositório é privado: sua conta do GitHub precisa ter acesso.

## Configuração

Preencha **JWT_SECRET** em `backend/.env` com um valor aleatório de pelo menos 32 caracteres (o exemplo vem vazio). Para gerar um:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Para ver os dados de exemplo, mude **`DEMO_MODE=true`** em `backend/.env` e **`VITE_DEMO_MODE=true`** em `frontend/.env`. Sem isso, os indicadores mostram só dados operacionais e começam vazios. Mantenha as duas opções desligadas em produção.

| Backend: variável | Configuração |
|---|---|
| `MONGODB_URI` | Obrigatória; exemplo `mongodb://localhost:27017/it-helpdesk` |
| `JWT_SECRET` | Obrigatória; aleatória, pelo menos 32 caracteres |
| `PORT` | Opcional; padrão `3000` |
| `DEMO_MODE` | Opcional; padrão `false`; `true` libera origens demo/legado nos indicadores somente fora de produção |
| `APP_TIMEZONE` | Opcional; fuso IANA válido, padrão `America/Fortaleza`; períodos e horários gerenciais |
| `JWT_EXPIRES_IN` | Opcional; padrão `8h`; inteiro positivo seguido de `s`, `m`, `h` ou `d` |
| `CORS_ORIGIN` | Opcional; padrão `http://localhost:5173`; origens separadas por vírgula |
| `SEED_TI_EMAIL` / `SEED_TI_PASSWORD` | Obrigatórias para seed; valores demonstrativos no exemplo; senha com pelo menos 8 caracteres |
| `SEED_SOLICITANTE_EMAIL` / `SEED_SOLICITANTE_PASSWORD` | Obrigatórias para seed; mesmos requisitos |
| `SEED_GESTOR_EMAIL` / `SEED_GESTOR_PASSWORD` | Opcionais para seed; preencher ambas ou nenhuma; senha com pelo menos 8 caracteres |
| `EMAIL_ENABLED` | Opcional; padrão `false`; `true` liga as [notificações por e-mail](#notificações-por-e-mail) |
| `EMAIL_PROVIDER` | Opcional; `mailpit` (padrão, caixa local), `resend` ou `gmail` (envio real) |
| `EMAIL_FROM` | Opcional; remetente, padrão `IT Helpdesk <helpdesk@helpdesk.local>`; com Resend, um endereço de domínio verificado |
| `APP_PUBLIC_URL` | Opcional; padrão `http://localhost:5173`; endereço da interface usado nos links dos e-mails |
| `MAILPIT_URL` | Opcional; padrão `http://127.0.0.1:8025`; API do Mailpit |
| `RESEND_API_KEY` | Obrigatória só com `EMAIL_PROVIDER=resend` e e-mail ligado; nunca versionar |
| `AI_WORKER_URL` / `AI_WORKER_KEY` | Opcionais; preencher ambas ou nenhuma; endereço do serviço de respostas e a chave de acesso recebida do dono. Sem elas, o [assistente](#assistente) responde em modo demonstrativo |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Obrigatórias só com `EMAIL_PROVIDER=gmail` e e-mail ligado; conta Gmail remetente e sua senha de app; nunca versionar |
| `EMAIL_RECIPIENT_ALLOWLIST` | Opcional; fora de produção, o Resend e o Gmail só enviam para estes endereços ou `@domínios`, separados por vírgula |

No frontend, **VITE_API_URL** é a URL da API com `/api` (`http://localhost:3000/api`, também o padrão do cliente) e **VITE_DEMO_MODE** mostra os seletores de origem (padrão `false`). As variáveis do backend são validadas com Zod na inicialização. Arquivos `.env` são ignorados pelo Git; só os `.env.example` são versionados.

O MongoDB do Compose roda sem autenticação e publica a porta apenas em `127.0.0.1`, para desenvolvimento e avaliação local.

### Dados de demonstração

Em `backend`, com o MongoDB no ar:

```bash
npm run seed            # cria os usuários TI, solicitante e (com SEED_GESTOR) gestor
npm run seed:demo       # até 10 chamados de exemplo
npm run seed:incidents  # publica o incidente "Instabilidade na rede Wi-Fi"
npm run seed:articles   # cinco artigos de ajuda fictícios
npm run seed:scenarios  # cenários fictícios claros, percorridos pelo fluxo real
npm run seed:inventory  # empresa fictícia: departamentos, salas, estoque e patrimônios
```

Todos podem ser executados de novo sem duplicar dados: usuários existentes não têm senha nem papel alterados, chamados com o mesmo título são pulados, e o incidente e os artigos existentes (inclusive se editados) são mantidos. Em caso de erro, encerram com código 1.

`seed:scenarios` cria pedidos com títulos específicos (por exemplo "Impressora do setor administrativo sem conexão" e "Notebook desligando sozinho durante reuniões") e executa cada etapa pelos mesmos serviços da aplicação: atendimento, resolução, confirmação com nota e contestação. Os quatro cenários de equipe (segundo solicitante e segundo analista, resolução por outro responsável e um incidente da rede cabeada) só rodam se as contas adicionais existirem. Não altera registros existentes nem cria histórico com datas passadas. Detalhes em [cenários de demonstração](docs/05-demonstracao.md#cenários-de-demonstração).

`seed:inventory` cria cinco departamentos com salas (Financeiro 203, RH 105, Administração 301, TI 110, Comercial 205), coloca as contas fictícias nesses setores (só se ainda não tiverem um), cadastra materiais e patrimônios de exemplo e executa os cenários do estoque pelos serviços da aplicação: o teclado trocado no Financeiro, um mouse entregue no RH, um monitor enviado para manutenção, um notebook transferido para o Comercial, um headset abaixo do mínimo e uma retirada acima do saldo, recusada. Rodar de novo não muda nada; recusa produção e contas que não sejam as fictícias. As marcas e modelos são exemplos para a demonstração.

O seed gerencial opcional (`npm run seed:manager`) cria 24 chamados fictícios por mês para os gráficos da gestão. Exige as contas adicionais `demo.ti2@helpdesk.local` e `demo.solicitante2@helpdesk.local` e a variável `LOCAL_DEMO_SEED=1`, e recusa bancos remotos ou de produção. Em PowerShell, a partir da raiz:

```powershell
cd backend
$env:LOCAL_DEMO_SEED = '1'
npm run seed:manager
Remove-Item Env:LOCAL_DEMO_SEED
```

Detalhes e restrições em [seed gerencial local](docs/05-demonstracao.md#seed-gerencial-local).

## Execução

Com o Docker Desktop iniciado e o MongoDB no ar (`docker compose up -d --wait`), abra dois terminais na raiz:

```bash
# Terminal 1: API em http://localhost:3000
cd backend
npm run dev
```

```bash
# Terminal 2: interface em http://localhost:5173
cd frontend
npm run dev
```

Acesse **http://localhost:5173**. A API só aceita requisições depois de conectar ao MongoDB; configuração inválida ou banco indisponível impedem a inicialização.

Para parar o banco: `docker compose down` na raiz. O volume `mongo-data` preserva os dados; `docker compose down -v` apaga o volume e não é necessário para a demonstração.

Build de produção local, em terminais separados:

```bash
# API
cd backend
npm run build
npm start
```

```bash
# Interface: preview em http://localhost:4173
cd frontend
npm run build
npm run preview
```

Para o preview, inclua `http://localhost:4173` em CORS_ORIGIN e reinicie a API.

## Usuários demonstrativos

Valores do `backend/.env.example`, criados por `npm run seed`:

| Perfil | Nome | E-mail | Senha | Página inicial |
|---|---|---|---|---|
| Solicitante | Mariana Souza | `solicitante@helpdesk.local` | `Solicitante@2026` | Início |
| TI | Carlos Andrade | `ti@helpdesk.local` | `TiDemo@2026` | Atendimento |
| Gestor | Ana Ribeiro | `gestor@helpdesk.local` | `Gestor@2026` | Visão gerencial |

Se o seu `.env` foi criado antes do gestor, acrescente as duas variáveis SEED_GESTOR do exemplo e rode o seed de novo. Não há cadastro público. Não use essas credenciais em produção.

O passo a passo de cada perfil está em [como usar, por perfil](docs/03-fluxos-e-api.md#como-usar-por-perfil).

## Testes

Com as dependências instaladas, `backend/.env` válido e o MongoDB no ar (Docker Desktop iniciado), a partir da raiz:

```bash
cd backend
npm test
npm run test:typecheck
npm run docs:check
npm run build
npm run test:e2e

cd ../frontend
npm run lint -- --deny-warnings
npm run build
```

- **Integração (`npm test`):** autenticação, isolamento, permissões dos três perfis, validação, transições, histórico, concorrência, dashboards, visão gerencial, rate limit, incidentes compartilhados, privacidade das respostas, base de conhecimento, classificação orientada e confirmação de resolução, departamentos e salas, catálogo, saldo, concorrência, idempotência, estornos, patrimônio, entregas ligadas a chamados, indicadores de estoque e notificações por e-mail (fila, destinatário, conteúdo, preferências, novas tentativas, concorrência, reinício, confirmação e troca de e-mail, com provedores simulados). Usa bancos `it-helpdesk-test*`, apagados ao final; o banco de desenvolvimento não é tocado.
- **E2E (`npm run test:e2e`):** sobe API e Vite em portas livres com banco e usuários temporários, abre o Edge/Chrome headless e percorre login/logout, páginas iniciais dos três perfis, isolamento, operações do gestor, conflito por revisão, filtros, estados de carregamento e erro, layout em 390, 768 e 1650 px (container alinhado ao cabeçalho, formulário de suporte em duas colunas, grades sem cartão isolado e texto do botão principal visível com o mouse sobre ele) e os fluxos completos de incidente compartilhado, artigo de ajuda, pedido guiado, confirmação e contestação de resolução, quadro (incluindo teclado, justificativa, conflito 409 e filtros recolhidos no celular) e estoque (o teclado do Financeiro de ponta a ponta, com o saldo conferido na API, cadastro de material, entrada, estoque insuficiente, transferência de patrimônio, 390 px, permissões e consumo na visão gerencial) e a página Minha conta com o e-mail desligado (aviso, preferência salva e botão de conta no celular). Se o navegador não for encontrado, defina `E2E_BROWSER_PATH`. Diagnósticos de falha ficam em `backend/e2e-results/`, ignorado pelo Git.
- **Documentação (`npm run docs:check`):** links, âncoras, imagens, viewport e tema de cada captura, scripts npm citados, variáveis dos exemplos e credenciais demonstrativas.

O que cada teste cobre: [o que os testes verificam](docs/05-demonstracao.md#o-que-os-testes-verificam).

## Documentação complementar

- [Produto, regras, incidentes, base de conhecimento, classificação, confirmação e estoque](docs/01-produto-e-regras.md)
- [Arquitetura, coleções e índices](docs/02-arquitetura-e-dados.md)
- [Como usar por perfil, ciclo de vida e API](docs/03-fluxos-e-api.md)
- [Métricas, decisões técnicas e limitações](docs/04-metricas-decisoes-e-limites.md)
- [Roteiro de demonstração, capturas e solução de problemas](docs/05-demonstracao.md)
- [Auditoria, ciclos e compatibilidade](docs/06-integridade-e-auditoria.md)

```text
backend/
  src/              API: rotas, controllers, services, models e autenticação
  src/scripts/      Seeds e manutenção local protegida
  tests/            Integração e E2E em ambiente isolado
  scripts/          Verificação documental e captura de telas
frontend/
  src/pages/        Telas dos três perfis
  src/components/   Interface, incidentes, quadro, artigos e gráficos
  src/services/     Cliente HTTP e contratos
docs/               Documentação técnica e capturas
docker-compose.yml  MongoDB e caixa de e-mail (Mailpit) locais
```

## Limitações conhecidas

- JWT fica no localStorage: um XSS poderia expor o token, e o logout só limpa a sessão local. Login limita 10 tentativas por IP a cada 15 minutos, com contador em memória.
- Sem notificações push, anexos, comentários, recuperação de senha ou administração de usuários pela interface.
- O assistente escolhe as informações por palavras da pergunta (sem busca semântica): perguntas muito genéricas podem trazer poucas fontes. Os indicadores do gestor usam dados operacionais, como a visão gerencial abre; o assistente não troca de origem.
- E-mails só para o solicitante e só sobre o próprio pedido; nada para a equipe nem sobre incidentes. O envio roda no mesmo processo da API, a cada 5 segundos, sem fila externa. O Mailpit não tem chave de idempotência: se a API cair entre o envio e o registro, a caixa local pode mostrar a mensagem duas vezes (o Resend descarta a repetição por 24 horas).
- Estoque sem compras, fornecedores, custos, notas fiscais ou código de barras; reservas são entregues ou canceladas por inteiro; o local informado na abertura do chamado não é editado depois.
- Incidentes não avisam ativamente; o usuário vê o problema ao abrir o sistema. Não há vínculo de outros chamados ao incidente nem sugestão automática de problemas parecidos.
- A busca de artigos compara palavras (sem acento) por expressão regular e ordena pela atualização mais recente, sem ranking de relevância; atende o volume de demonstração, não uma base grande. Artigos não têm imagens nem anexos.
- As perguntas do pedido guiado são fixas no código (um catálogo por categoria), não configuráveis pela interface.
- O quadro não tem arrastar e soltar: as mudanças de status são feitas pelos botões dos cartões. A avaliação de atendimento é por resolução e opcional; não há lembrete para quem não respondeu.
- Sem SLA, tempo médio de atendimento ou evolução histórica do backlog. Indicadores mostram estado atual e ações comprovadas, não qualidade da equipe.
- O MongoDB local roda sem réplica, portanto sem transações entre coleções. Encerrar o incidente após resolver o chamado são duas escritas, e uma falha entre elas é corrigida na leitura seguinte.
- Dashboards não atualizam em tempo real. A escolha de tema fica no navegador (localStorage), não na conta: em outro navegador a pessoa começa no tema claro.

Mais detalhes em [métricas, decisões e limites](docs/04-metricas-decisoes-e-limites.md).
