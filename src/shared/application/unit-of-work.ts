/**
 * Fronteira transacional explícita. `Scope` é um agrupamento de
 * repositórios/ports já vinculados à mesma transação SQL (o mesmo
 * EntityManager "forkado", no caso da implementação MikroORM). Todo caso de
 * uso que precisa de atomicidade entre wallet + ledger + wager transaction +
 * inbox + outbox chama `unitOfWork.run(async (scope) => { ... })` — ou tudo
 * confirma junto, ou nada confirma (seção 11 do desafio).
 */
export interface UnitOfWork<Scope> {
  run<T>(fn: (scope: Scope) => Promise<T>): Promise<T>;
}
