import { Wallet } from '../../domain/wallet';

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');

export interface WalletRepositoryPort {
  /** Insere uma nova carteira. Lança ConflictError se (playerId, currency) já existir
   * (a unicidade é garantida por índice único no banco — ver migração 0001). */
  insert(wallet: Wallet): Promise<void>;

  /**
   * Busca a carteira travando a linha (SELECT ... FOR UPDATE) para uso dentro
   * de uma transação que vai mutar o saldo. Esta é A unidade de concorrência
   * do sistema: nenhuma outra transação consegue ler esta linha com lock até
   * o commit/rollback da transação atual.
   */
  findByIdForUpdate(id: string): Promise<Wallet | null>;

  findById(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;

  /** Lista todas as carteiras cadastradas, paginado por cursor (keyset,
   * ordenado por createdAt DESC). Não faz parte do desafio original —
   * adicionado como conveniência operacional. */
  listAll(cursor?: string, limit?: number): Promise<{ items: Wallet[]; nextCursor?: string }>;

  /** Persiste saldo/versão atualizados. Implementações com bloqueio otimista
   * devem incluir `WHERE version = :expectedVersion` e lançar
   * OptimisticLockError em caso de 0 linhas afetadas. */
  save(wallet: Wallet): Promise<void>;
}
