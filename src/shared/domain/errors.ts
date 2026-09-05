export class DomainError extends Error {
  constructor(
    message: string,
    public readonly failureCode: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(from: string, attempted: string) {
    super(`Cannot transition WagerTransaction from terminal state "${from}" to "${attempted}"`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor() {
    super('Wallet balance is insufficient for this debit', 'INSUFFICIENT_BALANCE');
  }
}

export class NegativeBalanceGuardError extends DomainError {
  constructor() {
    super('Operation would drive wallet balance negative', 'NEGATIVE_BALANCE_GUARD');
  }
}

export class UnbalancedLedgerEntryError extends Error {
  constructor() {
    super('balanceBefore ± money must equal balanceAfter');
    this.name = 'UnbalancedLedgerEntryError';
  }
}
