import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { MoneyDto } from '@modules/wallets/presentation/dto/wallet.dto';

export enum WagerTransactionKindDto {
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export class SubmitWagerTransactionDto {
  @IsString()
  providerId!: string;

  @IsString()
  externalTransactionId!: string;

  @IsUUID('7')
  playerId!: string;

  @IsUUID('7')
  walletId!: string;

  @IsString()
  roundId!: string;

  @IsString()
  gameId!: string;

  @IsEnum(WagerTransactionKindDto)
  kind!: WagerTransactionKindDto;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}
