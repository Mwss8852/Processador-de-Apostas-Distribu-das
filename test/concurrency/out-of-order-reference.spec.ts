import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, truncateAll, newUow } from '../integration/setup';
import { CreateWalletUseCase } from '@modules/wallets/application/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from '@modules/wagering/application/submit-wager-transaction.use-case';
import { ProcessPendingReferencesUseCase } from '@modules/wagering/application/process-pending-references.use-case';
import { v7 as uuidv7 } from 'uuid';
import { WagerTransactionKind, WagerTransactionStatus } from '@modules/wagering/domain/wager-transaction';
import { FailureCode } from '@shared/domain/failure-codes';

describe('§7.1 — referência fora de ordem: ROLLBACK/REFUND antes do BET (reordenamento do SQS)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  it('REFUND que chega antes do BET fica PENDING_REFERENCE e é resolvido quando o BET chega', async () => {
    const setupUow = newUow(orm);
    const createWallet = new CreateWalletUseCase(setupUow);
    const wallet = await createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    const betExternalId = uuidv7();
    const submit = new SubmitWagerTransactionUseCase(newUow(orm));

    // REFUND chega primeiro, referenciando um BET que ainda não existe.
    const refundResult = await submit.execute({
      idempotencyKey: `provider-a:refund-${betExternalId}`,
      providerId: 'provider-a',
      externalTransactionId: `refund-${betExternalId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
      correlationId: uuidv7(),
    });

    expect(refundResult.status).toBe(WagerTransactionStatus.PendingReference);

    // Agora o BET chega.
    const submitBet = new SubmitWagerTransactionUseCase(newUow(orm));
    const betResult = await submitBet.execute({
      idempotencyKey: `provider-a:${betExternalId}`,
      providerId: 'provider-a',
      externalTransactionId: betExternalId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });
    expect(betResult.status).toBe(WagerTransactionStatus.Processed);
    expect(betResult.balance?.amount).toBe('75.00'); // 100 - 25

    // O worker de reprocessamento resolve o REFUND pendente.
    const worker = new ProcessPendingReferencesUseCase(newUow(orm));
    const processedCount = await worker.executeBatch(10);
    expect(processedCount).toBeGreaterThanOrEqual(1);

    const conn = orm.em.getConnection();
    const [refundRow] = await conn.execute<{ status: string }[]>('SELECT status FROM wager_transactions WHERE id = ?', [refundResult.transactionId]);
    expect(refundRow?.status).toBe(WagerTransactionStatus.Processed);

    const [walletRow] = await conn.execute<{ balance: string }[]>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
    // 100 (opening) - 25 (bet) + 25 (refund) = 100
    expect(walletRow?.balance).toBe('100.00');
  });

  it('a mesma referência não pode ser revertida duas vezes pelo mesmo kind', async () => {
    const setupUow = newUow(orm);
    const createWallet = new CreateWalletUseCase(setupUow);
    const wallet = await createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    const betExternalId = uuidv7();
    const submitBet = new SubmitWagerTransactionUseCase(newUow(orm));
    await submitBet.execute({
      idempotencyKey: `provider-a:${betExternalId}`,
      providerId: 'provider-a',
      externalTransactionId: betExternalId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    const refundOnce = new SubmitWagerTransactionUseCase(newUow(orm));
    const first = await refundOnce.execute({
      idempotencyKey: 'provider-a:refund-1',
      providerId: 'provider-a',
      externalTransactionId: 'refund-1',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
      correlationId: uuidv7(),
    });
    expect(first.status).toBe(WagerTransactionStatus.Processed);

    const refundTwice = new SubmitWagerTransactionUseCase(newUow(orm));
    const second = await refundTwice.execute({
      idempotencyKey: 'provider-a:refund-2',
      providerId: 'provider-a',
      externalTransactionId: 'refund-2',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
      correlationId: uuidv7(),
    });
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });
});
