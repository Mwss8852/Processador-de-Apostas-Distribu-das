import { Money, MoneyProps } from '@shared/domain/money';
import { FailureCode } from '@shared/domain/failure-codes';
import { InvalidTransactionStateError } from '@shared/domain/errors';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

const TERMINAL_STATUSES = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const KINDS_REQUIRING_REFERENCE = new Set<WagerTransactionKind>([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** Quais kinds cada kind de referência pode apontar para. */
const ALLOWED_REFERENCE_KINDS: Record<string, WagerTransactionKind[]> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  attempts: number;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _attempts: number,
  ) {}

  /** Nasce em PENDING (ou PENDING_REFERENCE se a referência ainda não existir
   * — quem decide isso é o caso de uso, após consultar o repositório; aqui
   * só validamos que kinds que exigem referência a declararam). */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new Error('OPENING transactions cannot be created through the public factory');
    }
    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && !props.referenceExternalTransactionId) {
      throw new Error(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (!KINDS_REQUIRING_REFERENCE.has(props.kind) && props.referenceExternalTransactionId) {
      throw new Error(`${props.kind} must not declare a reference`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      0,
    );
  }

  /** Uso interno exclusivo do caso de uso CreateWallet para o crédito de abertura. */
  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      new Date(),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      0,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.attempts,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get attempts(): number {
    return this._attempts;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    if (this._status === WagerTransactionStatus.PendingReference) {
      this._attempts += 1;
      return;
    }
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts += 1;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date();
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** LOSS e qualquer REJECTED não afetam saldo. */
  affectsBalance(): boolean {
    if (this.kind === WagerTransactionKind.Loss) return false;
    if (this._status === WagerTransactionStatus.Rejected) return false;
    return true;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Valida se `reference` é um kind aceitável para este REFUND/ROLLBACK. */
  isValidReferenceKind(reference: WagerTransaction): boolean {
    const allowed = ALLOWED_REFERENCE_KINDS[this.kind];
    return allowed !== undefined && allowed.includes(reference.kind);
  }

  /** Direção do lançamento no ledger para este kind, dada a referência quando aplicável. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new Error('ROLLBACK requires a reference to determine ledger direction');
        // ROLLBACK inverte o efeito da referência: se a referência creditou,
        // o rollback debita, e vice-versa.
        const refDirection = reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Debit : LedgerDirection.Credit;
        return refDirection === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new Error('LOSS never generates a ledger entry');
    }
  }

  private assertNotTerminal(attempted: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, attempted);
    }
  }
}
