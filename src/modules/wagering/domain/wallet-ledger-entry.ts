import { Money, MoneyProps } from '@shared/domain/money';
import { UnbalancedLedgerEntryError } from '@shared/domain/errors';
import { LedgerDirection } from './wager-transaction';

export { LedgerDirection };

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

/**
 * Lançamento de ledger — SEM campos mutáveis, SEM métodos de transição.
 * A imutabilidade é estrutural (propriedades `readonly`), não uma
 * convenção de código. `create` valida a aritmética antes de instanciar:
 * não existe WalletLedgerEntry inválido em memória.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const expected =
      props.direction === LedgerDirection.Credit
        ? props.balanceBefore.add(props.money)
        : props.balanceBefore.subtract(props.money);

    if (!expected.equals(props.balanceAfter)) {
      throw new UnbalancedLedgerEntryError();
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(),
    );

    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError();
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.money),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
