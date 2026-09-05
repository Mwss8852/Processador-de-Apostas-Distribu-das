import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from './mikro-orm.config';

/**
 * Executor de migrações programático. O CLI oficial (`mikro-orm migration:up`)
 * depende do runtime Node + ts-node para carregar `mikro-orm.config.ts`, o
 * que é frágil em um projeto Bun-first. Aqui chamamos a mesma API
 * (`orm.getMigrator()`) que o CLI usa por baixo dos panos, mas via um script
 * que o próprio Bun executa nativamente — sem loader extra.
 *
 * Uso: bun run src/database/migrate-cli.ts up|down
 */
async function main() {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') {
    console.error('Uso: bun run src/database/migrate-cli.ts <up|down>');
    process.exit(1);
  }

  const orm = await MikroORM.init(mikroOrmConfig);
  const migrator = orm.getMigrator();

  try {
    if (direction === 'up') {
      const executed = await migrator.up();
      console.log(`Migrações aplicadas: ${executed.length === 0 ? '(nenhuma pendente)' : executed.map((m) => m.name).join(', ')}`);
    } else {
      const executed = await migrator.down();
      console.log(`Migração revertida: ${executed.length === 0 ? '(nenhuma para reverter)' : executed.map((m) => m.name).join(', ')}`);
    }
  } finally {
    await orm.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
