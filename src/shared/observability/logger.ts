import pino from 'pino';
import { LoggerService } from '@nestjs/common';

/**
 * Logs estruturados (JSON) com correlationId/messageId/transactionId/
 * walletId/providerId quando disponíveis. NUNCA logamos o corpo financeiro
 * completo (amount, saldo) nem o payload bruto da mensagem — apenas os
 * identificadores necessários para correlacionar eventos entre serviços.
 */
export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['*.money', '*.amount', '*.balance', '*.balanceBefore', '*.balanceAfter'],
});

export function createLogger(component: string): LoggerService {
  const logger = rootLogger.child({ component });
  return {
    log: (message, ...opt) => logger.info({ opt }, String(message)),
    error: (message, ...opt) => logger.error({ opt }, String(message)),
    warn: (message, ...opt) => logger.warn({ opt }, String(message)),
    debug: (message, ...opt) => logger.debug({ opt }, String(message)),
    verbose: (message, ...opt) => logger.trace({ opt }, String(message)),
  };
}

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

export function withContext(component: string, ctx: LogContext) {
  return rootLogger.child({ component, ...ctx });
}
