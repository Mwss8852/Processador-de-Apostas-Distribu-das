export interface AppEnv {
  port: number;
  databaseUrl: string;
  sqsEndpoint: string | undefined;
  sqsRegion: string;
  sqsWagerQueueUrl: string;
  sqsWagerDlqUrl: string;
  outboxPublisherIntervalMs: number;
  outboxBatchSize: number;
  pendingReferenceIntervalMs: number;
  pendingReferenceBatchSize: number;
  consumerName: string;
}

export function loadEnv(): AppEnv {
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
    sqsEndpoint: process.env.SQS_ENDPOINT,
    sqsRegion: process.env.AWS_REGION ?? 'us-east-1',
    sqsWagerQueueUrl: process.env.SQS_WAGER_QUEUE_URL ?? '',
    sqsWagerDlqUrl: process.env.SQS_WAGER_DLQ_URL ?? '',
    outboxPublisherIntervalMs: Number(process.env.OUTBOX_PUBLISHER_INTERVAL_MS ?? 500),
    outboxBatchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 50),
    pendingReferenceIntervalMs: Number(process.env.PENDING_REFERENCE_INTERVAL_MS ?? 10_000),
    pendingReferenceBatchSize: Number(process.env.PENDING_REFERENCE_BATCH_SIZE ?? 100),
    consumerName: process.env.CONSUMER_NAME ?? 'wager-transactions-consumer',
  };
}
