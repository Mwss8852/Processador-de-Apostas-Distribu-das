import { describe, it, expect } from 'bun:test';
import { WalletLedgerEntry, LedgerDirection } from '@modules/wagering/domain/wallet-ledger-entry';
import { Money } from '@shared/domain/money';
import { UnbalancedLedgerEntryError } from '@shared/domain/errors';

function money(amount: string) {
  return Money.from({ amount, currency: 'BRL' });
}

describe('WalletLedgerEntry', () => {
  it('create() validates balanceBefore + money === balanceAfter for CREDIT', () => {
    const entry = WalletLedgerEntry.create({
      id: 'e1',
      walletId: 'w1',
      transactionId: 't1',
      direction: LedgerDirection.Credit,
      money: money('10.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('110.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('create() validates balanceBefore - money === balanceAfter for DEBIT', () => {
    const entry = WalletLedgerEntry.create({
      id: 'e1',
      walletId: 'w1',
      transactionId: 't1',
      direction: LedgerDirection.Debit,
      money: money('30.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('70.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects unbalanced arithmetic at construction time — never allowed to exist in memory', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'e1',
        walletId: 'w1',
        transactionId: 't1',
        direction: LedgerDirection.Debit,
        money: money('10.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('95.00'), // deveria ser 90.00
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('has no mutation methods — the class only exposes readonly fields and isBalanced()', () => {
    const entry = WalletLedgerEntry.create({
      id: 'e1',
      walletId: 'w1',
      transactionId: 't1',
      direction: LedgerDirection.Credit,
      money: money('10.00'),
      balanceBefore: money('0.00'),
      balanceAfter: money('10.00'),
    });
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));
    expect(methodNames.sort()).toEqual(['constructor', 'isBalanced'].sort());
  });
});
