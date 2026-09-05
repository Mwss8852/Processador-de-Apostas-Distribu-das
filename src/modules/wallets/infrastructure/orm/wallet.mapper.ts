import { Wallet } from '@modules/wallets/domain/wallet';
import { WalletOrmEntity } from './wallet.orm-entity';

export class WalletMapper {
  static toOrm(wallet: Wallet, existing?: WalletOrmEntity): WalletOrmEntity {
    const orm = existing ?? new WalletOrmEntity();
    orm.id = wallet.id;
    orm.playerId = wallet.playerId;
    orm.currency = wallet.currency;
    orm.balance = wallet.balance.toDecimalString();
    orm.version = wallet.version;
    orm.createdAt = wallet.createdAt;
    orm.updatedAt = wallet.updatedAt;
    return orm;
  }

  static toDomain(orm: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: orm.id,
      playerId: orm.playerId,
      currency: orm.currency,
      balance: { amount: orm.balance, currency: orm.currency },
      version: orm.version,
      createdAt: orm.createdAt,
      updatedAt: orm.updatedAt,
    });
  }
}
