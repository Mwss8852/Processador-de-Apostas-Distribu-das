import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, truncateAll, newUow } from './setup';
import { CreateWalletUseCase } from '@modules/wallets/application/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from '@modules/wagering/application/submit-wager-transaction.use-case';
import { v7 as uuidv7 } from 'uuid';
import { WagerTransactionKind, WagerTransactionStatus } from '@modules/wagering/domain/wager-transaction';
import { FailureCode } from '@shared/domain/failure-codes';

/**
 * Requer PostgreSQL real e migrado (ver package.json -> test:integration e
 * docker-compose.yml). Não roda contra mocks.
 */
describe('Atomicidade: wallet + ledger + transaction + outbox (§11)', () => {
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

  it('uma BET processada grava wallet, ledger, transaction e outbox na mesma transação SQL', async () => {
    const uow = newUow(orm);
    const createWallet = new CreateWalletUseCase(uow);
    const submit = new SubmitWagerTransactionUseCase(uow);

    const wallet = await createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    const result = await submit.execute({
      idempotencyKey: `provider-a:${uuidv7()}`,
      providerId: 'provider-a',
      externalTransactionId: uuidv7(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance?.amount).toBe('75.00');

    const conn = orm.em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string; version: number }[]>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
    expect(walletRow?.balance).toBe('75.00');
    expect(walletRow?.version).toBe(3); // open(1) + crédito de abertura(2) + débito do BET(3)

    const ledgerRows = await conn.execute<{ direction: string; amount: string }[]>('SELECT direction, amount FROM wallet_ledger_entries WHERE wallet_id = ?', [wallet.id]);
    // OPENING (credit 100) + BET (debit 25) = 2 lançamentos
    expect(ledgerRows).toHaveLength(2);

    const outboxRows = await conn.execute<{ event_type: string }[]>('SELECT event_type FROM outbox_messages ORDER BY occurred_at ASC');
    expect(outboxRows.map((r) => r.event_type)).toContain('WagerTransactionProcessed');
    expect(outboxRows.map((r) => r.event_type)).toContain('WalletBalanceChanged');
  });

  it('uma BET rejeitada por saldo insuficiente NÃO gera lançamento de ledger, mas gera transação e evento auditáveis', async () => {
    const uow = newUow(orm);
    const createWallet = new CreateWalletUseCase(uow);
    const submit = new SubmitWagerTransactionUseCase(uow);

    const wallet = await createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    const result = await submit.execute({
      idempotencyKey: `provider-a:${uuidv7()}`,
      providerId: 'provider-a',
      externalTransactionId: uuidv7(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientBalance);

    const conn = orm.em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string }[]>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
    expect(walletRow?.balance).toBe('10.00'); // saldo intacto

    const ledgerRows = await conn.execute<unknown[]>('SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND transaction_id = ?', [
      wallet.id,
      result.transactionId,
    ]);
    expect(ledgerRows).toHaveLength(0);

    const txRows = await conn.execute<{ status: string }[]>('SELECT status FROM wager_transactions WHERE id = ?', [result.transactionId]);
    expect(txRows[0]?.status).toBe('REJECTED');
  });
});
