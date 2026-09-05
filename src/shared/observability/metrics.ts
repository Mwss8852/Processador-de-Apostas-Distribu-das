import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const wagerTransactionsTotal = new Counter({
  name: 'wager_transactions_total',
  help: 'Transações de aposta processadas, por kind e status final',
  labelNames: ['kind', 'status'] as const,
  registers: [registry],
});

export const duplicatesDetectedTotal = new Counter({
  name: 'duplicates_detected_total',
  help: 'Deduplicações por inbox (mensagem) ou por idempotency key (negócio)',
  labelNames: ['source'] as const, // 'inbox' | 'idempotency_key'
  registers: [registry],
});

export const messageRetriesTotal = new Counter({
  name: 'message_retries_total',
  help: 'Reentregas de mensagens SQS reprocessadas pelo consumer',
  registers: [registry],
});

export const dlqMessagesTotal = new Counter({
  name: 'dlq_messages_total',
  help: 'Mensagens movidas para a DLQ após esgotar o limite de tentativas',
  registers: [registry],
});

export const lockConflictsTotal = new Counter({
  name: 'wallet_lock_conflicts_total',
  help: 'Tentativas de aquisição de lock de wallet que precisaram esperar/retry',
  registers: [registry],
});

export const outboxLagSeconds = new Histogram({
  name: 'outbox_publish_lag_seconds',
  help: 'Tempo entre o enfileiramento do evento e sua publicação efetiva',
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const processingLatencySeconds = new Histogram({
  name: 'wager_transaction_processing_latency_seconds',
  help: 'Latência de processamento de uma transação de aposta, ponta a ponta',
  labelNames: ['channel'] as const, // 'http' | 'sqs'
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const reconciliationDivergenceTotal = new Counter({
  name: 'wallet_reconciliation_divergence_total',
  help: 'Divergências detectadas entre saldo materializado e saldo recalculado do ledger',
  registers: [registry],
});
