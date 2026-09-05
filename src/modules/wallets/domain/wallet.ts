import { Money, MoneyProps } from '@shared/domain/money';
import { InsufficientBalanceError, NegativeBalanceGuardError } from '@shared/domain/errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

/** Resultado de uma movimentação — a Wallet nunca cria o WalletLedgerEntry
 * sozinha (isso é responsabilidade da camada de aplicação, que também grava
 * o ledger na mesma transação), mas devolve os dados necessários para tal. */
export interface BalanceMutation {
  balanceBefore: Money;
  balanceAfter: Money;
}

/**
 * Wallet é a raiz agregada e a UNIDADE DE CONCORRÊNCIA (ver ARCHITECTURE.md §5).
 * Toda mutação de saldo passa por debit()/credit(), que:
 *   - validam a moeda,
 *   - nunca permitem saldo negativo,
 *   - incrementam version apenas quando o saldo efetivamente muda.
 * A raiz NÃO conhece o banco, SQL ou bloqueio — isso é responsabilidade do
 * repositório (SELECT ... FOR UPDATE) antes de a aplicação chamar estes
 * métodos dentro de uma transação.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    const now = new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Debita `money` do saldo. Lança InsufficientBalanceError se o saldo
   * resultante for negativo devido a saldo insuficiente para uma aposta
   * (failureCode INSUFFICIENT_BALANCE), ou NegativeBalanceGuardError para
   * qualquer outro caminho que produziria saldo negativo (failureCode
   * NEGATIVE_BALANCE_GUARD) — são situações operacionalmente distintas,
   * ver seção 7 do desafio.
   */
  debit(money: Money, options: { guardOnly?: boolean } = {}): BalanceMutation {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new NegativeBalanceGuardError();
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(money);

    if (balanceAfter.isNegative()) {
      throw options.guardOnly ? new NegativeBalanceGuardError() : new InsufficientBalanceError();
    }

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date();

    return { balanceBefore, balanceAfter };
  }

  credit(money: Money): BalanceMutation {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      // crédito de valor zero não altera saldo nem versão — trate fora daqui.
      throw new NegativeBalanceGuardError();
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(money);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date();

    return { balanceBefore, balanceAfter };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new Error(`Wallet currency "${this.currency}" does not match operation currency "${money.currency}"`);
    }
  }
}
