import 'reflect-metadata';
import { bootstrapContext } from '@config/bootstrap-context';
import { withContext } from '@shared/observability/logger';

async function main() {
  const ctx = await bootstrapContext();
  const log = withContext('pending-reference-worker', {});
  let shuttingDown = false;
  process.on('SIGTERM', () => {
    log.info('SIGTERM received, finishing current batch then exiting');
    shuttingDown = true;
  });

  log.info('pending-reference reprocessing worker starting');

  while (!shuttingDown) {
    try {
      const processed = await ctx.useCases.processPendingReferences.executeBatch(ctx.env.pendingReferenceBatchSize);
      if (processed > 0) log.info({ processed }, 'reprocessed pending-reference batch');
    } catch (err) {
      log.error({ err: String(err) }, 'failed to reprocess pending-reference batch, will retry next tick');
    }
    await sleep(ctx.env.pendingReferenceIntervalMs);
  }

  await ctx.orm.close();
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
