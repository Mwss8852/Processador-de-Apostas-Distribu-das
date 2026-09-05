import { describe, it, expect } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  LedgerDirection,
} from '@modules/wagering/domain/wager-transaction';
import { Money } from '@shared/domain/money';
import { FailureCode } from '@shared/domain/failure-codes';
import { InvalidTransactionStateError } from '@shared/domain/errors';

function baseProps(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return {
    id: 't1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'hash-A',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    ...overrides,
  };
}

describe('WagerTransaction', () => {
  it('is created in PENDING status', () => {
    const tx = WagerTransaction.create(baseProps());
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
  });

  it('OPENING cannot be created through the public factory', () => {
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Opening }))).toThrow();
  });

  it('REFUND/ROLLBACK require a reference; BET/WIN/LOSS must not declare one', () => {
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Refund }))).toThrow();
    expect(() =>
      WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Bet, referenceExternalTransactionId: 'x' } as never),
      ),
    ).toThrow();
  });

  it('terminal statuses (PROCESSED/REJECTED/FAILED) never transition again', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.markProcessed(undefined, new Date());
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientBalance)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.TransientInfrastructureFailure)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it('LOSS never affects balance, even before being marked processed', () => {
    const tx = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss }));
    expect(tx.affectsBalance()).toBe(false);
  });

  it('a REJECTED transaction never affects balance', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.reject(FailureCode.InsufficientBalance);
    expect(tx.affectsBalance()).toBe(false);
    expect(tx.failureCode).toBe(FailureCode.InsufficientBalance);
  });

  it('REFUND may only reference a BET', () => {
    const bet = WagerTransaction.create(baseProps({ id: 'bet1' }));
    const win = WagerTransaction.create(
      baseProps({ id: 'win1', kind: WagerTransactionKind.Win, externalTransactionId: 'x-win' }),
    );
    const refund = WagerTransaction.create(
      baseProps({
        id: 'refund1',
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'x-refund',
        referenceExternalTransactionId: 'transaction-123',
      }),
    );
    expect(refund.isValidReferenceKind(bet)).toBe(true);
    expect(refund.isValidReferenceKind(win)).toBe(false);
  });

  it('ROLLBACK may reference BET, WIN or REFUND, and inverts the referenced direction', () => {
    const bet = WagerTransaction.create(baseProps({ id: 'bet1' }));
    const win = WagerTransaction.create(
      baseProps({ id: 'win1', kind: WagerTransactionKind.Win, externalTransactionId: 'x-win' }),
    );
    const rollbackOfBet = WagerTransaction.create(
      baseProps({
        id: 'rb1',
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: 'x-rb1',
        referenceExternalTransactionId: 'transaction-123',
      }),
    );
    const rollbackOfWin = WagerTransaction.create(
      baseProps({
        id: 'rb2',
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: 'x-rb2',
        referenceExternalTransactionId: 'x-win',
      }),
    );

    expect(rollbackOfBet.isValidReferenceKind(bet)).toBe(true);
    expect(rollbackOfBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit); // BET debitou -> rollback credita
    expect(rollbackOfWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit); // WIN creditou -> rollback debita
  });

  it('idempotency: matchesPayload distinguishes a safe replay from a payload conflict', () => {
    const tx = WagerTransaction.create(baseProps({ payloadHash: 'hash-A' }));
    expect(tx.matchesPayload('hash-A')).toBe(true); // replay seguro
    expect(tx.matchesPayload('hash-B')).toBe(false); // conflito, não replay
  });

  it('PENDING_REFERENCE tracks retry attempts across the scheduled worker (§7.1)', () => {
    const tx = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'missing-ref' }),
    );
    tx.markPendingReference();
    tx.markPendingReference();
    tx.markPendingReference();
    expect(tx.attempts).toBe(3);
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });

  it('exhausting the PENDING_REFERENCE retry budget rejects with a distinct failureCode', () => {
    const tx = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'missing-ref' }),
    );
    tx.markPendingReference();
    tx.reject(FailureCode.ReferenceNotFoundTimeout);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFoundTimeout);
  });
});
