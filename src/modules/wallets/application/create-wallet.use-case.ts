import { v7 as uuidv7 } from 'uuid';
import { Money, MoneyProps } from '@shared/domain/money';
import { Wallet } from '../domain/wallet';
import { ConflictError } from '@shared/application/application-errors';
import { UnitOfWork } from '@shared/application/unit-of-work';
import { WalletRepositoryPort } from './ports/wallet-repository.port';
import { WagerTransactionRepositoryPort, LedgerRepositoryPort } from '@modules/wagering/application/ports/wagering-repository.ports';
import { OutboxRepositoryPort } from '@messaging/messaging-ports';
import { WagerTransaction } from '@modules/wagering/domain/wager-transaction';
import { WalletLedgerEntry, LedgerDirection } from '@modules/wagering/domain/wallet-ledger-entry';
import { WalletBalanceChanged } from '@messaging/events/wallet-balance-changed.event';
import { computeWagerPayloadHash } from '@shared/application/payload-hash';

export interface CreateWalletScope {
  wallets: WalletRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  ledger: LedgerRepositoryPort;
  outbox: OutboxRepositoryPort;
}

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class CreateWalletUseCase {
  constructor(private readonly uow: UnitOfWork<CreateWalletScope>) {}

  async execute(cmd: CreateWalletCommand): Promise<CreateWalletResult> {
    const initialBalance = Money.fromInput(cmd.initialBalance);

    return this.uow.run(async (scope) => {
      const existing = await scope.wallets.findByPlayerAndCurrency(cmd.playerId, initialBalance.currency);
      if (existing) {
        throw new ConflictError(`Wallet already exists for playerId="${cmd.playerId}" currency="${initialBalance.currency}"`);
      }

      const walletId = uuidv7();
      const wallet = Wallet.open({ id: walletId, playerId: cmd.playerId, initialBalance: Money.zero(initialBalance.currency) });
      await scope.wallets.insert(wallet);

      if (initialBalance.isPositive()) {
        const openingId = uuidv7();
        const payloadHash = computeWagerPayloadHash({
          providerId: 'internal',
          externalTransactionId: `opening:${walletId}`,
          playerId: cmd.playerId,
          walletId,
          roundId: 'internal',
          gameId: 'internal',
          kind: 'OPENING',
          money: initialBalance.toJSON(),
        });

        const opening = WagerTransaction.createOpening({
          id: openingId,
          providerId: 'internal',
          externalTransactionId: `opening:${walletId}`,
          idempotencyKey: `internal:opening:${walletId}`,
          payloadHash,
          walletId,
          playerId: cmd.playerId,
          roundId: 'internal',
          gameId: 'internal',
          money: initialBalance,
        });

        const mutation = wallet.credit(initialBalance);
        const entry = WalletLedgerEntry.create({
          id: uuidv7(),
          walletId,
          transactionId: openingId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: mutation.balanceBefore,
          balanceAfter: mutation.balanceAfter,
        });

        opening.markProcessed(undefined, new Date());
        await scope.transactions.insert(opening);
        await scope.ledger.insert(entry);
        await scope.wallets.save(wallet);
        await scope.outbox.enqueue(
          WalletBalanceChanged.from(wallet, entry, { correlationId: cmd.correlationId }),
        );
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
