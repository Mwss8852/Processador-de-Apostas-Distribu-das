import 'reflect-metadata';
import { ReceiveMessageCommand, DeleteMessageCommand, Message } from '@aws-sdk/client-sqs';
import { bootstrapContext, AppContext } from '@config/bootstrap-context';
import { WagerTransactionKind } from '@modules/wagering/domain/wager-transaction';
import { InvalidPayloadError, TransientInfrastructureError, NotFoundError } from '@shared/application/application-errors';
import { InvalidMoneyError, MoneyCurrencyMismatchError } from '@shared/domain/money';
import { withContext } from '@shared/observability/logger';
import { duplicatesDetectedTotal, messageRetriesTotal, dlqMessagesTotal, processingLatencySeconds } from '@shared/observability/metrics';

interface WagerTransactionRequestedMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

/** Erros de negócio (rejeição, payload inválido) são terminais para a
 * MENSAGEM: fazemos ack (delete) porque a decisão já foi tomada e
 * persistida — reentregar não mudaria o resultado. Erros de infraestrutura
 * são transitórios: NÃO fazemos ack, deixamos a visibility timeout expirar
 * para nova tentativa (e eventual DLQ via redrive policy da fila). */
function isTerminalBusinessOutcome(err: unknown): boolean {
  return err instanceof InvalidPayloadError || err instanceof InvalidMoneyError || err instanceof MoneyCurrencyMismatchError || err instanceof NotFoundError;
}

async function processMessage(ctx: AppContext, raw: Message): Promise<'ack' | 'retry'> {
  const log = withContext('sqs-consumer', { messageId: raw.MessageId });
  if (!raw.Body || !raw.MessageId) {
    log.warn('message without body/messageId, acking to avoid poison-pill loop');
    return 'ack';
  }

  let parsed: WagerTransactionRequestedMessage;
  try {
    parsed = JSON.parse(raw.Body);
  } catch {
    log.error('invalid JSON body, acking (poison pill, would never succeed on retry)');
    return 'ack';
  }

  const stopTimer = processingLatencySeconds.startTimer({ channel: 'sqs' });
  try {
    const result = await ctx.useCases.submitWagerTransaction.execute({
      idempotencyKey: parsed.data.idempotencyKey,
      providerId: parsed.data.providerId,
      externalTransactionId: parsed.data.externalTransactionId,
      playerId: parsed.data.playerId,
      walletId: parsed.data.walletId,
      roundId: parsed.data.roundId,
      gameId: parsed.data.gameId,
      kind: parsed.data.kind as WagerTransactionKind,
      money: parsed.data.money,
      referenceExternalTransactionId: parsed.data.referenceExternalTransactionId,
      correlationId: parsed.messageId,
      inbound: { consumerName: ctx.env.consumerName, messageId: raw.MessageId },
    });

    if (result.idempotentReplay) {
      duplicatesDetectedTotal.inc({ source: 'inbox_or_idempotency_key' });
    }
    withContext('sqs-consumer', { messageId: raw.MessageId, transactionId: result.transactionId, walletId: parsed.data.walletId }).info(
      { status: result.status },
      'wager transaction processed from SQS',
    );
    return 'ack';
  } catch (err) {
    if (isTerminalBusinessOutcome(err)) {
      log.warn({ err: String(err) }, 'terminal business outcome, acking message');
      return 'ack';
    }
    if (err instanceof TransientInfrastructureError) {
      messageRetriesTotal.inc();
      log.error({ err: String(err) }, 'transient infrastructure failure, leaving message for retry');
      return 'retry';
    }
    messageRetriesTotal.inc();
    log.error({ err: String(err) }, 'unexpected error, leaving message for retry');
    return 'retry';
  } finally {
    stopTimer();
  }
}

async function main() {
  const ctx = await bootstrapContext();
  const log = withContext('sqs-consumer', {});
  let shuttingDown = false;
  const inFlight = new Set<Promise<void>>();

  process.on('SIGTERM', () => {
    log.info('SIGTERM received, will stop polling and drain in-flight messages');
    shuttingDown = true;
  });

  log.info({ queueUrl: ctx.env.sqsWagerQueueUrl }, 'sqs consumer starting');

  while (!shuttingDown) {
    const received = await ctx.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: ctx.env.sqsWagerQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10, // long polling
        VisibilityTimeout: 30,
      }),
    );

    for (const message of received.Messages ?? []) {
      const task = (async () => {
        const outcome = await processMessage(ctx, message);
        if (outcome === 'ack' && message.ReceiptHandle) {
          await ctx.sqs.send(new DeleteMessageCommand({ QueueUrl: ctx.env.sqsWagerQueueUrl, ReceiptHandle: message.ReceiptHandle }));
        }
        // outcome === 'retry': não deletamos; a visibility timeout expira e
        // o SQS reentrega. Após `maxReceiveCount` (definido na redrive
        // policy da fila, ver docker-compose/localstack init), o próprio
        // SQS move a mensagem para wager-transactions-dlq.fifo.
        if (outcome === 'retry' && (message.Attributes?.['ApproximateReceiveCount'] ?? '1') !== '1') {
          dlqMessagesTotal.inc(0); // apenas garante a série de tempo exista; contagem real via CloudWatch/redrive na fila
        }
      })();
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    }
  }

  log.info({ inFlight: inFlight.size }, 'draining in-flight messages before exit');
  await Promise.allSettled([...inFlight]);
  await ctx.orm.close();
  process.exit(0);
}

main();
