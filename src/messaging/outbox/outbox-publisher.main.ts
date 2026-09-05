import 'reflect-metadata';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { bootstrapContext } from '@config/bootstrap-context';
import { MikroOrmOutboxRepository } from '@messaging/infrastructure/orm/messaging.repository';
import { withContext } from '@shared/observability/logger';
import { outboxLagSeconds } from '@shared/observability/metrics';

/**
 * Loop de publicação. A cada iteração:
 *   1) BEGIN
 *   2) SELECT ... FOR UPDATE SKIP LOCKED (lote de mensagens pendentes/devidas)
 *   3) publica cada uma no SQS
 *   4) marca publishedAt e COMMIT
 *
 * Se o processo morre entre o passo 3 e o 4 (publicou mas não commitou o
 * `publishedAt`), a mensagem será publicada DE NOVO na próxima rodada —
 * publicação duplicada é aceitável (o consumidor faz dedup por messageId),
 * perda de evento não é.
 *
 * Múltiplas instâncias deste worker podem rodar em paralelo: `SKIP LOCKED`
 * garante que cada uma pega um lote disjunto de linhas.
 */
async function main() {
  const ctx = await bootstrapContext();
  const log = withContext('outbox-publisher', {});
  let shuttingDown = false;
  process.on('SIGTERM', () => {
    log.info('SIGTERM received, finishing current batch then exiting');
    shuttingDown = true;
  });

  log.info('outbox publisher starting');

  while (!shuttingDown) {
    let publishedInBatch = 0;
    try {
      publishedInBatch = await publishDueBatch(ctx);
    } catch (err) {
      log.error({ err: String(err) }, 'failed to publish outbox batch, will retry next tick');
    }

    if (publishedInBatch === 0) {
      await sleep(ctx.env.outboxPublisherIntervalMs);
    }
  }

  await ctx.orm.close();
  process.exit(0);
}

async function publishDueBatch(ctx: Awaited<ReturnType<typeof bootstrapContext>>): Promise<number> {
  return ctx.uow.run(async (scope) => {
    const outbox = scope.outbox as MikroOrmOutboxRepository;
    const batch = await outbox.lockDueBatchForUpdate(ctx.env.outboxBatchSize);
    const log = withContext('outbox-publisher', {});

    for (const message of batch) {
      const lagSeconds = (Date.now() - message.occurredAt.getTime()) / 1000;
      try {
        await ctx.sqs.send(
          new SendMessageCommand({
            QueueUrl: ctx.env.sqsWagerQueueUrl,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId, // FIFO: ordena por agregado (wallet/transaction)
            MessageDeduplicationId: message.id,
          }),
        );
        message.markPublished(new Date());
        await outbox.save(message);
        outboxLagSeconds.observe(lagSeconds);
      } catch (err) {
        message.scheduleRetry(new Date());
        await outbox.save(message);
        withContext('outbox-publisher', { messageId: message.id }).error({ err: String(err) }, 'failed to publish outbox message, scheduled retry');
      }
    }
    return batch.length;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
