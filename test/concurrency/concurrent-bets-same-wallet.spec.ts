import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, truncateAll, newUow } from '../integration/setup';
import { CreateWalletUseCase } from '@modules/wallets/application/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from '@modules/wagering/application/submit-wager-transaction.use-case';
import { v7 as uuidv7 } from 'uuid';
import { WagerTransactionKind, WagerTransactionStatus } from '@modules/wagering/domain/wager-transaction';
import { FailureCode } from '@shared/domain/failure-codes';

/**
 * Cenário obrigatório da seção 8. Cada "requisição" usa seu PRÓPRIO
 * EntityManager forkado (como aconteceria com requisições HTTP concorrentes
 * reais em processos/instâncias distintas) para que o SELECT ... FOR UPDATE
 * realmente serialize no Postgres, e não apenas na memória do processo Node.
 */
describe('§8 — cenário obrigatório: duas apostas de 80.00 contra saldo de 100.00', () => {
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

  it('exatamente uma PROCESSED, a outra REJECTED, saldo final 20.00, um único lançamento de débito', async () => {
    const setupUow = newUow(orm);
    const createWallet = new CreateWalletUseCase(setupUow);
    const wallet = await createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    const bet = {
      providerId: 'provider-a',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-race',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    };

    const submitA = new SubmitWagerTransactionUseCase(newUow(orm));
    const submitB = new SubmitWagerTransactionUseCase(newUow(orm));

    const [resultA, resultB] = await Promise.all([
      submitA.execute({ ...bet, idempotencyKey: 'provider-a:bet-A', externalTransactionId: 'bet-A', correlationId: uuidv7() }),
      submitB.execute({ ...bet, idempotencyKey: 'provider-a:bet-B', externalTransactionId: 'bet-B', correlationId: uuidv7() }),
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());

    const rejected = resultA.status === WagerTransactionStatus.Rejected ? resultA : resultB;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientBalance);

    const conn = orm.em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string; version: number }[]>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
    expect(walletRow?.balance).toBe('20.00');
    expect(walletRow?.version).toBe(3); // open(1) + opening credit(2) + a única bet processada(3)

    const debitEntries = await conn.execute<unknown[]>(
      "SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    );
    expect(debitEntries).toHaveLength(1);
  });

  it('50 submissões paralelas da MESMA idempotency-key produzem um único débito', async () => {
    const setupUow = newUow(orm);
    const createWallet = new CreateWalletUseCase(setupUow);
    const wallet = await createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: '1000.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    const command = {
      idempotencyKey: 'provider-a:duplicate-bet',
      providerId: 'provider-a',
      externalTransactionId: 'duplicate-bet',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-dup',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };

    const attempts = Array.from({ length: 50 }, () => {
      const submit = new SubmitWagerTransactionUseCase(newUow(orm));
      return submit.execute({ ...command, correlationId: uuidv7() });
    });

    const results = await Promise.all(attempts);
    const processedFirst = results.filter((r) => !r.idempotentReplay);
    expect(processedFirst).toHaveLength(1);

    const conn = orm.em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string }[]>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
    expect(walletRow?.balance).toBe('990.00');

    const debitCount = await conn.execute<{ count: string }[]>(
      "SELECT COUNT(*)::text as count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    );
    expect(debitCount[0]?.count).toBe('1');
  });

  it('carteiras diferentes processam apostas em paralelo sem contenção entre si', async () => {
    const setupUow = newUow(orm);
    const createWallet = new CreateWalletUseCase(setupUow);

    const wallets = await Promise.all(
      Array.from({ length: 5 }, () =>
        createWallet.execute({ playerId: uuidv7(), initialBalance: { amount: '100.00', currency: 'BRL' }, correlationId: uuidv7() }),
      ),
    );

    const results = await Promise.all(
      wallets.map((w) => {
        const submit = new SubmitWagerTransactionUseCase(newUow(orm));
        return submit.execute({
          idempotencyKey: `provider-a:${w.id}`,
          providerId: 'provider-a',
          externalTransactionId: w.id,
          playerId: w.playerId,
          walletId: w.id,
          roundId: 'round-parallel',
          gameId: 'fortune-chimp',
          kind: WagerTransactionKind.Bet,
          money: { amount: '30.00', currency: 'BRL' },
          correlationId: uuidv7(),
        });
      }),
    );

    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.every((r) => r.balance?.amount === '70.00')).toBe(true);
  });
});
