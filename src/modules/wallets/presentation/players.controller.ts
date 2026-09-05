import { Controller, Get, Param, Query } from '@nestjs/common';
import { GetWalletByPlayerUseCase } from '@modules/wallets/application/wallet-queries.use-case';
import { toHttpException } from '@shared/presentation/http-error-mapping';

/**
 * NÃO faz parte do desafio original (que não define um agregado "Player").
 * Adicionado como conveniência para consultar a carteira de um jogador sem
 * precisar guardar o walletId separadamente — útil em testes manuais.
 */
@Controller('players')
export class PlayersController {
  constructor(private readonly getWalletByPlayer: GetWalletByPlayerUseCase) {}

  @Get(':playerId/wallet')
  async wallet(@Param('playerId') playerId: string, @Query('currency') currency?: string) {
    try {
      return await this.getWalletByPlayer.execute(playerId, currency ?? 'BRL');
    } catch (err) {
      throw toHttpException(err);
    }
  }
}
