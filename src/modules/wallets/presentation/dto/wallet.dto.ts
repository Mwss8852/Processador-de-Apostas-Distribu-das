import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, ValidateNested } from 'class-validator';

export class MoneyDto {
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'amount must be a plain decimal string with up to 2 fraction digits' })
  amount!: string;

  @IsString()
  @IsIn(['BRL'], { message: 'only BRL is supported in this deployment (domain remains multi-currency capable)' })
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID('7')
  playerId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance?: MoneyDto;
}

export class ListLedgerQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  limit?: number;
}

export class ListWalletsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  limit?: number;
}
