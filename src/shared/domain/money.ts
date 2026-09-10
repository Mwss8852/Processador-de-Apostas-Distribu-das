import Decimal from 'decimal.js';

/**
 * Money é o único tipo permitido para valores monetários no domínio.
 * Nunca use number/float/double — ver ARCHITECTURE.md §3 (Modelagem de dinheiro).
 *
 * Representação: string decimal com escala fixa de 2 casas (ex.: "25.00").
 * Internamente usamos Decimal.js configurado para nunca cair em notação
 * exponencial e para arredondar (quando necessário) por ROUND_HALF_UP —
 * mas note que a maioria das operações aqui NÃO arredonda: elas rejeitam
 * entradas com mais de 2 casas em vez de arredondar silenciosamente.
 */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const DECIMAL_INPUT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

// Conjunto de códigos ISO-4217 alpha-3 reconhecidos. Uma regex de 3 letras
// maiúsculas (ex.: /^[A-Z]{3}$/) aceitaria "REA", "XXX" ou qualquer
// combinação inventada — a validação precisa ser contra códigos reais.
const ISO_4217_CURRENCIES = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP',
  'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD',
  'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR',
  'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF',
  'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL',
  'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR',
  'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR',
  'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR',
  'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD',
  'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SYP', 'SZL', 'THB', 'TJS',
  'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD',
  'UYU', 'UZS', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XOF', 'XPF',
  'YER', 'ZAR', 'ZMW', 'ZWL',
]);

export class MoneyCurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: cannot operate on "${a}" and "${b}"`);
    this.name = 'MoneyCurrencyMismatchError';
  }
}

export class InvalidMoneyError extends Error {
  constructor(reason: string) {
    super(`Invalid money value: ${reason}`);
    this.name = 'InvalidMoneyError';
  }
}

Decimal.set({ toExpNeg: -30, toExpPos: 30, rounding: Decimal.ROUND_HALF_UP });

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof amount !== 'string' || amount.trim().length === 0) {
      throw new InvalidMoneyError('amount must be a non-empty decimal string');
    }
    if (!DECIMAL_INPUT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount "${amount}" is not a plain decimal string with up to 2 fraction digits`,
      );
    }
    if (!currency || !ISO_4217_CURRENCIES.has(currency)) {
      throw new InvalidMoneyError(`currency "${currency}" must be an ISO-4217 alpha-3 code`);
    }

    const decimal = new Decimal(amount);
    if (!decimal.isFinite()) {
      throw new InvalidMoneyError('amount must be finite');
    }

    return new Money(decimal.toDecimalPlaces(SCALE), currency);
  }

  static fromInput(props: MoneyProps): Money {
    const money = Money.from(props);
    if (money.isNegative()) {
      throw new InvalidMoneyError('negative amounts are not allowed in input contracts');
    }
    return money;
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value).toDecimalPlaces(SCALE), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value).toDecimalPlaces(SCALE), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThanOrEqualTo(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  toDecimalString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyCurrencyMismatchError(this.currency, other.currency);
    }
  }
}