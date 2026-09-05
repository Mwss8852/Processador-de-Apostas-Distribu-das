import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, truncateAll, newUow } from './setup';
import { CreateWalletUseCase } from '@modules/wallets/application/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from '@modules/wagering/application/submit-wager-transaction.use-case';
import { v7 as uuidv7 } from 'uuid';
import { WagerTransactionKind } from '@modules/wagering/domain/wager-transaction';
import { IdempotencyConflictError } from '@shared/application/application-errors';

describe('Idempotência e deduplicação de mensagens (§9, §10)', () => {
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

  it('a mesma Idempotency-Key com o mesmo payload devolve idempotentReplay=true e não duplica efeitos', async () => {
    const uow = newUow(orm);
    const createWallet = new CreateWalletUseCase(uow);
    const submit = new SubmitWagerTransactionUseCase(uow);

    const wallet = await createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    const command = {
      idempotencyKey: 'provider-a:transaction-123',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      correlationId: uuidv7(),
    };

    const first = await submit.execute(command);
    const second = await submit.execute({ ...command, correlationId: uuidv7() });

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balance).toEqual(first.balance);

    const conn = orm.em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string }[]>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
    expect(walletRow?.balance).toBe('75.00'); // debitado apenas uma vez
  });

  it('a mesma Idempotency-Key com payload DIFERENTE é conflito, não replay', async () => {
    const uow = newUow(orm);
    const createWallet = new CreateWalletUseCase(uow);
    const submit = new SubmitWagerTransactionUseCase(uow);

    const wallet = await createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    const base = {
      idempotencyKey: 'provider-a:transaction-123',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      correlationId: uuidv7(),
    };

    await submit.execute({ ...base, money: { amount: '25.00', currency: 'BRL' } });

    await expect(submit.execute({ ...base, money: { amount: '30.00', currency: 'BRL' }, correlationId: uuidv7() })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('uma mensagem SQS reentregue (mesmo messageId) não reprocessa efeitos', async () => {
    const uow = newUow(orm);
    const createWallet = new CreateWalletUseCase(uow);
    const submit = new SubmitWagerTransactionUseCase(uow);

    const wallet = await createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: uuidv7(),
    });

    const messageId = uuidv7();
    const command = {
      idempotencyKey: 'provider-a:transaction-123',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      correlationId: uuidv7(),
      inbound: { consumerName: 'wager-transactions-consumer', messageId },
    };

    const first = await submit.execute(command);
    const redelivered = await submit.execute({ ...command, correlationId: uuidv7() });

    expect(first.idempotentReplay).toBe(false);
    expect(redelivered.idempotentReplay).toBe(true);
    expect(redelivered.transactionId).toBe(first.transactionId);
  });
});
