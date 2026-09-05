import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { CreateWalletDto, ListLedgerQueryDto, ListWalletsQueryDto } from './dto/wallet.dto';
import { CreateWalletUseCase } from '../application/create-wallet.use-case';
import { GetWalletUseCase, ListWalletLedgerUseCase, ListWalletsUseCase } from '../application/wallet-queries.use-case';
import { ReconcileWalletUseCase } from '@modules/wagering/application/wagering-queries.use-case';
import { toHttpException } from '@shared/presentation/http-error-mapping';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listWallets: ListWalletsUseCase,
    private readonly listLedger: ListWalletLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateWalletDto) {
    try {
      return await this.createWallet.execute({
        playerId: dto.playerId,
        initialBalance: dto.initialBalance ?? { amount: '0.00', currency: 'BRL' },
        correlationId: uuidv7(),
      });
    } catch (err) {
      throw toHttpException(err);
    }
  }

  // Rota estática precisa vir ANTES de ':walletId' — caso contrário o
  // NestJS tentaria casar "GET /wallets" com o parâmetro dinâmico primeiro
  // dependendo da ordem de declaração dos métodos.
  @Get()
  async list(@Query() query: ListWalletsQueryDto) {
    try {
      return await this.listWallets.execute(query.cursor, query.limit ?? 50);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    try {
      return await this.getWallet.execute(walletId);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: ListLedgerQueryDto) {
    try {
      return await this.listLedger.execute(walletId, query.cursor, query.limit ?? 50);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconciliation(@Param('walletId') walletId: string) {
    try {
      return await this.reconcile.execute(walletId);
    } catch (err) {
      throw toHttpException(err);
    }
  }
}
