import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { KnowledgeArticleModel, type KnowledgeArticle } from '../models/article.model';
import { UserModel } from '../models/user.model';
import { normalizeForSearch } from '../services/article.service';

/**
 * Demonstration help articles, run after `npm run seed`. Fictitious, generic guidance: no company
 * policy, no password sharing, no disabling security, no destructive commands.
 * Each article has a stable demoKey: running the seed again keeps existing articles as they are,
 * including any edits made in the app.
 */

type DemoArticle = Pick<KnowledgeArticle, 'title' | 'summary' | 'category' | 'body'> & { demoKey: string };

export const DEMO_ARTICLES: DemoArticle[] = [
  {
    demoKey: 'demo-kb-wifi',
    title: 'Como verificar problemas de Wi-Fi',
    summary: 'Passos rápidos para quando a internet sem fio cai, fica lenta ou não conecta.',
    category: 'rede',
    body: [
      'Antes de abrir um pedido, confira se o problema é só no seu equipamento ou se atinge mais pessoas.',
      '1. Veja se o Wi-Fi do computador está ligado e se o modo avião está desativado.',
      '2. Confirme se você está conectado à rede correta do escritório.',
      '3. Desconecte e conecte de novo na rede.',
      '4. Teste em outro dispositivo, como o celular, no mesmo lugar.',
      '5. Se possível, aproxime-se do ponto de acesso e veja se a conexão melhora.',
      'Se outras pessoas próximas também estão sem conexão, veja em Problemas conhecidos se a TI já está cuidando disso.',
      'Ao pedir ajuda, informe o local, desde quando acontece e se a conexão cai ou não conecta.',
    ].join('\n\n'),
  },
  {
    demoKey: 'demo-kb-printer',
    title: 'O que fazer quando a impressora não responde',
    summary: 'Verificações simples antes de pedir suporte para uma impressora parada.',
    category: 'hardware',
    body: [
      'Muitas falhas de impressão se resolvem com verificações simples.',
      '- Confira se a impressora está ligada e sem mensagem de erro no visor.',
      '- Verifique se há papel e se nenhuma bandeja está aberta.',
      '- Veja se você escolheu a impressora certa na hora de imprimir.',
      '- Abra a fila de impressão do computador e veja se há documentos parados.',
      '- Desligue a impressora, aguarde alguns segundos e ligue de novo.',
      'Não tente abrir a impressora para mexer em peças internas além das indicadas pelo fabricante para retirar papel.',
      'Ao pedir ajuda, informe qual impressora é (local ou nome) e a mensagem exibida, se houver.',
    ].join('\n\n'),
  },
  {
    demoKey: 'demo-kb-program',
    title: 'Primeiras verificações quando um programa não abre',
    summary: 'O que tentar quando um aplicativo trava, fecha sozinho ou mostra erro ao abrir.',
    category: 'software',
    body: [
      'Algumas verificações resolvem boa parte dos casos e ajudam a TI a entender o problema.',
      '1. Feche o programa por completo e abra de novo.',
      '2. Salve seus arquivos e reinicie o computador.',
      '3. Veja se o problema acontece com qualquer arquivo ou só com um arquivo específico.',
      '4. Anote a mensagem de erro exatamente como aparece, ou faça uma captura da tela.',
      'Não reinstale nem remova programas por conta própria e não desative o antivírus para testar.',
      'Ao pedir ajuda, informe o nome do programa, a mensagem de erro e quando o problema começou.',
    ].join('\n\n'),
  },
  {
    demoKey: 'demo-kb-access',
    title: 'Como descrever um problema de acesso',
    summary: 'O que informar quando não consegue entrar em um sistema ou falta permissão.',
    category: 'acesso',
    body: [
      'Problemas de acesso são resolvidos mais rápido quando a TI sabe exatamente o que aconteceu.',
      '- Qual sistema você está tentando acessar.',
      '- Se o erro aparece ao entrar (login) ou ao abrir uma área específica (permissão).',
      '- A mensagem de erro, exatamente como aparece.',
      '- Se o acesso funcionava antes e desde quando parou.',
      'Nunca informe sua senha, códigos de verificação ou tokens no pedido. A equipe de TI não precisa deles e não vai pedi-los.',
    ].join('\n\n'),
  },
  {
    demoKey: 'demo-kb-computer',
    title: 'Como identificar um defeito básico no computador',
    summary: 'Sinais que ajudam a separar um problema simples de um defeito no equipamento.',
    category: 'hardware',
    body: [
      'Observe o comportamento do equipamento antes de pedir ajuda.',
      '- O computador não liga: confira o cabo de energia, a tomada e, no notebook, se a bateria está carregando.',
      '- Liga mas a tela fica preta: verifique se o monitor está ligado e se o cabo de vídeo está bem encaixado.',
      '- Desliga sozinho ou esquenta muito: mantenha as saídas de ar livres e anote quando acontece.',
      '- Faz barulhos diferentes: desligue e não use o equipamento até a avaliação da TI.',
      'Não abra o gabinete nem o notebook. Se houver cheiro de queimado ou fumaça, desligue da tomada e avise a TI.',
      'Ao pedir ajuda, informe o equipamento (computador, notebook, monitor) e o que acontece ao tentar usá-lo.',
    ].join('\n\n'),
  },
];

const seedEnvSchema = z.object({
  SEED_TI_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
});

async function seedArticles(): Promise<void> {
  const seedEnv = seedEnvSchema.parse(process.env);
  await mongoose.connect(env.MONGODB_URI);
  await KnowledgeArticleModel.syncIndexes();

  const author = await UserModel.findOne({ email: seedEnv.SEED_TI_EMAIL });
  if (!author) throw new Error('Demo IT user not found. Run "npm run seed" first.');

  let created = 0;
  for (const article of DEMO_ARTICLES) {
    const now = new Date();
    // $setOnInsert: an existing article (maybe edited or archived in the app) is never changed.
    const result = await KnowledgeArticleModel.updateOne(
      { demoKey: article.demoKey },
      {
        $setOnInsert: {
          ...article,
          status: 'published',
          searchText: normalizeForSearch(`${article.title}\n${article.summary}\n${article.body}`),
          createdBy: author._id,
          updatedBy: author._id,
          publishedAt: now,
          revision: 1,
          dataOrigin: 'demo',
        },
      },
      { upsert: true },
    );
    created += result.upsertedCount;
    console.log(`- ${article.title}: ${result.upsertedCount ? 'created' : 'already exists, kept as is'}`);
  }
  console.log(`Article demo seed finished: ${created} created, ${DEMO_ARTICLES.length - created} kept`);
}

seedArticles()
  .catch((error: unknown) => {
    if (error instanceof z.ZodError) {
      console.error(`Invalid seed variables:\n${z.prettifyError(error)}`);
    } else {
      console.error('Article demo seed failed:', error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
