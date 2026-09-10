import { describe, it, expect } from 'bun:test';
import { Money, InvalidMoneyError, MoneyCurrencyMismatchError } from '@shared/domain/money';

describe('Money', () => {
  it('rejects more than 2 decimal places', () => {
    expect(() => Money.from({ amount: '10.123', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects scientific notation', () => {
    expect(() => Money.from({ amount: '1e10', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects NaN and Infinity string literals', () => {
    expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: 'Infinity', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects empty string', () => {
    expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects an invalid ISO-4217 currency', () => {
    expect(() => Money.from({ amount: '10.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '10.00', currency: 'REA' })).toThrow(InvalidMoneyError);
  });

  it('fromInput rejects negative amounts in contract boundaries', () => {
    expect(() => Money.fromInput({ amount: '-5.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('from() allows negative amounts for internal domain math (e.g. negate())', () => {
    const m = Money.from({ amount: '10.00', currency: 'BRL' }).negate();
    expect(m.toDecimalString()).toBe('-10.00');
  });

  it('add/subtract are precise (no float rounding) and immutable', () => {
    const a = Money.from({ amount: '10.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    const sum = a.add(b);
    expect(sum.toDecimalString()).toBe('10.30');
    expect(a.toDecimalString()).toBe('10.10');
  });

  it('cross-currency operations throw MoneyCurrencyMismatchError', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(MoneyCurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(MoneyCurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(MoneyCurrencyMismatchError);
  });

  it('equals() compares by value and currency, not by reference', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.equals(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('toJSON always serializes with a fixed 2-decimal scale', () => {
    const a = Money.from({ amount: '10', currency: 'BRL' });
    expect(a.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });
});