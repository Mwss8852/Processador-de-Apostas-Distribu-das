import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { SubmitWagerTransactionDto } from './dto/wagering.dto';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../application/wagering-queries.use-case';
import { toHttpException } from '@shared/presentation/http-error-mapping';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';

/**
 * Mapeamento de status HTTP do caminho feliz (seção 9 — precisa ser
 * distinguível de forma consistente):
 *   201 Created  -> PROCESSED em primeira tentativa (novo recurso criado)
 *   202 Accepted -> PENDING_REFERENCE (aceito, processamento pendente)
 *   200 OK       -> idempotentReplay=true (nada novo foi criado) OU
 *                   REJECTED por regra de negócio (recurso existe,
 *                   requisição foi entendida, decisão é de negócio)
 * Erros de payload/conflito/infra usam toHttpException (422/409/503/404).
 */
function statusFor(result: { status: string; idempotentReplay: boolean }): number {
  if (result.idempotentReplay) return 200;
  if (result.status === WagerTransactionStatus.Processed) return 201;
  if (result.status === WagerTransactionStatus.PendingReference) return 202;
  return 200; // REJECTED / FAILED
}

@Controller()
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({ message: 'Idempotency-Key header is required', failureCode: 'INVALID_PAYLOAD' });
    }

    try {
      const result = await this.submit.execute({
        idempotencyKey,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        playerId: dto.playerId,
        walletId: dto.walletId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: dto.kind as unknown as WagerTransactionKind,
        money: dto.money,
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
        correlationId: uuidv7(),
      });
      res.status(statusFor(result));
      return result;
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    try {
      return await this.getTransaction.execute(transactionId);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    try {
      return await this.getTransaction.executeByProviderExternalId(providerId, externalTransactionId);
    } catch (err) {
      throw toHttpException(err);
    }
  }
}
