import { describe, it, expect } from 'bun:test';
import { Wallet } from '@modules/wallets/domain/wallet';
import { Money } from '@shared/domain/money';
import { InsufficientBalanceError, NegativeBalanceGuardError } from '@shared/domain/errors';

function money(amount: string, currency = 'BRL') {
  return Money.from({ amount, currency });
}

describe('Wallet', () => {
  it('opens with the given initial balance, version 1', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('1000.00') });
    expect(w.balance.toDecimalString()).toBe('1000.00');
    expect(w.version).toBe(1);
  });

  it('debit decreases the balance and increments the version', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('100.00') });
    const mutation = w.debit(money('25.00'));
    expect(w.balance.toDecimalString()).toBe('75.00');
    expect(w.version).toBe(2);
    expect(mutation.balanceBefore.toDecimalString()).toBe('100.00');
    expect(mutation.balanceAfter.toDecimalString()).toBe('75.00');
  });

  it('credit increases the balance and increments the version', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('100.00') });
    w.credit(money('50.00'));
    expect(w.balance.toDecimalString()).toBe('150.00');
    expect(w.version).toBe(2);
  });

  it('never allows a negative balance: debit beyond balance throws and does not mutate state', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('10.00') });
    expect(() => w.debit(money('25.00'))).toThrow(InsufficientBalanceError);
    expect(w.balance.toDecimalString()).toBe('10.00');
    expect(w.version).toBe(1);
  });

  it('guardOnly debit distinguishes NEGATIVE_BALANCE_GUARD from INSUFFICIENT_BALANCE', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('10.00') });
    expect(() => w.debit(money('25.00'), { guardOnly: true })).toThrow(NegativeBalanceGuardError);
  });

  it('rejects operations in a different currency', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('10.00', 'BRL') });
    expect(() => w.debit(money('5.00', 'USD'))).toThrow();
  });

  it('rejects non-positive debit/credit amounts', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('10.00') });
    expect(() => w.debit(money('0.00'))).toThrow();
    expect(() => w.credit(money('0.00'))).toThrow();
  });

  it('§8 mandatory scenario: two 80.00 bets against a 100.00 balance under the same wallet lock', () => {
    // Este teste comprova a invariante em memória. A garantia real de
    // exclusão mútua entre PROCESSOS concorrentes vem do SELECT ... FOR
    // UPDATE no WalletRepository (ver test/concurrency), não daqui — a
    // Wallet em si é apenas o objeto de domínio que a transação de banco
    // protege.
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('100.00') });
    const bet = money('80.00');

    w.debit(bet);
    expect(() => w.debit(bet)).toThrow(InsufficientBalanceError);

    expect(w.balance.toDecimalString()).toBe('20.00');
    expect(w.version).toBe(2); // exatamente uma mutação de saldo
  });

  it('rehydrate reconstructs state without revalidating business transitions', () => {
    const w = Wallet.rehydrate({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      balance: { amount: '42.00', currency: 'BRL' },
      version: 7,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });
    expect(w.balance.toDecimalString()).toBe('42.00');
    expect(w.version).toBe(7);
  });
});
