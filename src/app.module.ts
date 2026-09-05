import { Module, OnModuleDestroy } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { AppContext, bootstrapContext } from '@config/bootstrap-context';
import { WalletsController } from '@modules/wallets/presentation/wallets.controller';
import { PlayersController } from '@modules/wallets/presentation/players.controller';
import { WageringController } from '@modules/wagering/presentation/wagering.controller';
import { HealthController } from './health/health.controller';
import { MetricsController } from './health/metrics.controller';
import { CreateWalletUseCase } from '@modules/wallets/application/create-wallet.use-case';
import { GetWalletUseCase, ListWalletLedgerUseCase, GetWalletByPlayerUseCase, ListWalletsUseCase } from '@modules/wallets/application/wallet-queries.use-case';
import { SubmitWagerTransactionUseCase } from '@modules/wagering/application/submit-wager-transaction.use-case';
import { GetWagerTransactionUseCase, ReconcileWalletUseCase } from '@modules/wagering/application/wagering-queries.use-case';

export const APP_CONTEXT = 'APP_CONTEXT';

@Module({
  imports: [TerminusModule],
  controllers: [WalletsController, PlayersController, WageringController, HealthController, MetricsController],
  providers: [
    { provide: APP_CONTEXT, useFactory: bootstrapContext },
    { provide: EntityManager, useFactory: (ctx: AppContext) => ctx.orm.em, inject: [APP_CONTEXT] },
    { provide: SQSClient, useFactory: (ctx: AppContext) => ctx.sqs, inject: [APP_CONTEXT] },
    { provide: CreateWalletUseCase, useFactory: (ctx: AppContext) => ctx.useCases.createWallet, inject: [APP_CONTEXT] },
    { provide: GetWalletUseCase, useFactory: (ctx: AppContext) => ctx.useCases.getWallet, inject: [APP_CONTEXT] },
    { provide: GetWalletByPlayerUseCase, useFactory: (ctx: AppContext) => ctx.useCases.getWalletByPlayer, inject: [APP_CONTEXT] },
    { provide: ListWalletsUseCase, useFactory: (ctx: AppContext) => ctx.useCases.listWallets, inject: [APP_CONTEXT] },
    { provide: ListWalletLedgerUseCase, useFactory: (ctx: AppContext) => ctx.useCases.listLedger, inject: [APP_CONTEXT] },
    { provide: ReconcileWalletUseCase, useFactory: (ctx: AppContext) => ctx.useCases.reconcileWallet, inject: [APP_CONTEXT] },
    {
      provide: SubmitWagerTransactionUseCase,
      useFactory: (ctx: AppContext) => ctx.useCases.submitWagerTransaction,
      inject: [APP_CONTEXT],
    },
    {
      provide: GetWagerTransactionUseCase,
      useFactory: (ctx: AppContext) => ctx.useCases.getWagerTransaction,
      inject: [APP_CONTEXT],
    },
  ],
})
export class AppModule implements OnModuleDestroy {
  constructor(private readonly em: EntityManager) {}

  async onModuleDestroy(): Promise<void> {
    await this.em.getConnection().close();
  }
}
