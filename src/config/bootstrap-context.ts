import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import mikroOrmConfig from '@database/mikro-orm.config';
import { loadEnv, AppEnv } from './env';
import { MikroOrmWageringUnitOfWork } from '@modules/wagering/infrastructure/orm/wagering-unit-of-work';
import { MikroOrmWalletRepository } from '@modules/wallets/infrastructure/orm/wallet.repository';
import { MikroOrmWagerTransactionRepository, MikroOrmLedgerRepository } from '@modules/wagering/infrastructure/orm/wagering.repository';
import { CreateWalletUseCase } from '@modules/wallets/application/create-wallet.use-case';
import { GetWalletUseCase, ListWalletLedgerUseCase, GetWalletByPlayerUseCase, ListWalletsUseCase } from '@modules/wallets/application/wallet-queries.use-case';
import { GetWagerTransactionUseCase, ReconcileWalletUseCase } from '@modules/wagering/application/wagering-queries.use-case';
import { SubmitWagerTransactionUseCase } from '@modules/wagering/application/submit-wager-transaction.use-case';
import { ProcessPendingReferencesUseCase } from '@modules/wagering/application/process-pending-references.use-case';

/**
 * Composição manual das dependências (poor-man's DI). Usada tanto pelo
 * módulo HTTP (app.module.ts, através de providers factory) quanto pelos
 * workers standalone (sqs-consumer, outbox-publisher,
 * process-pending-references), garantindo que TODOS os entrypoints
 * reutilizem exatamente os mesmos casos de uso e a mesma unidade de
 * transação — não há lógica duplicada entre HTTP e mensageria (seção 10).
 */
export interface AppContext {
  env: AppEnv;
  orm: MikroORM;
  sqs: SQSClient;
  uow: MikroOrmWageringUnitOfWork;
  useCases: {
    createWallet: CreateWalletUseCase;
    getWallet: GetWalletUseCase;
    getWalletByPlayer: GetWalletByPlayerUseCase;
    listWallets: ListWalletsUseCase;
    listLedger: ListWalletLedgerUseCase;
    submitWagerTransaction: SubmitWagerTransactionUseCase;
    getWagerTransaction: GetWagerTransactionUseCase;
    reconcileWallet: ReconcileWalletUseCase;
    processPendingReferences: ProcessPendingReferencesUseCase;
  };
}

export async function bootstrapContext(): Promise<AppContext> {
  const env = loadEnv();
  const orm = await MikroORM.init({ ...mikroOrmConfig, clientUrl: env.databaseUrl });
  const em = orm.em.fork();

  const sqs = new SQSClient({
    region: env.sqsRegion,
    ...(env.sqsEndpoint ? { endpoint: env.sqsEndpoint } : {}),
  });

  const uow = new MikroOrmWageringUnitOfWork(em);

  // Repositórios "de leitura direta" (fora de uma transação de escrita) —
  // usados apenas pelos casos de uso de consulta, que não precisam de lock.
  const wallets = new MikroOrmWalletRepository(em);
  const transactions = new MikroOrmWagerTransactionRepository(em);
  const ledger = new MikroOrmLedgerRepository(em);

  return {
    env,
    orm,
    sqs,
    uow,
    useCases: {
      createWallet: new CreateWalletUseCase(uow),
      getWallet: new GetWalletUseCase(wallets),
      getWalletByPlayer: new GetWalletByPlayerUseCase(wallets),
      listWallets: new ListWalletsUseCase(wallets),
      listLedger: new ListWalletLedgerUseCase(wallets, ledger),
      submitWagerTransaction: new SubmitWagerTransactionUseCase(uow),
      getWagerTransaction: new GetWagerTransactionUseCase(transactions),
      reconcileWallet: new ReconcileWalletUseCase(wallets, ledger),
      processPendingReferences: new ProcessPendingReferencesUseCase(uow),
    },
  };
}
