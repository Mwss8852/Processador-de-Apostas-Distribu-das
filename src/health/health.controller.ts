import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { HealthCheckService, HealthCheck, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
  ) {}

  /** Processo vivo — não depende de nenhuma dependência externa. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: 'ok' };
  }

  /** PostgreSQL e SQS alcançáveis. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.checkPostgres(), () => this.checkSqs()]);
  }

  private async checkPostgres(): Promise<HealthIndicatorResult> {
    try {
      await this.em.getConnection().execute('SELECT 1');
      return { postgres: { status: 'up' } };
    } catch (err) {
      throw new HealthCheckError('PostgreSQL unreachable', { postgres: { status: 'down', message: String(err) } });
    }
  }

  private async checkSqs(): Promise<HealthIndicatorResult> {
    try {
      const queueUrl = process.env.SQS_WAGER_QUEUE_URL;
      if (!queueUrl) throw new Error('SQS_WAGER_QUEUE_URL not configured');
      await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
      return { sqs: { status: 'up' } };
    } catch (err) {
      throw new HealthCheckError('SQS unreachable', { sqs: { status: 'down', message: String(err) } });
    }
  }
}
