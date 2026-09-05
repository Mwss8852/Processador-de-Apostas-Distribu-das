import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletOrmEntity } from '@modules/wallets/infrastructure/orm/wallet.orm-entity';
import { WagerTransactionOrmEntity } from '@modules/wagering/infrastructure/orm/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from '@modules/wagering/infrastructure/orm/wallet-ledger-entry.orm-entity';
import { InboxMessageOrmEntity, OutboxMessageOrmEntity } from '@messaging/infrastructure/orm/messaging.orm-entities';

/**
 * `forceUtcTimezone` + `driverOptions` mantêm todo timestamp em UTC.
 * NUMERIC columns são lidas/escritas como string (nunca number) — ver
 * `columnType: 'numeric(18,2)'` nas entidades; o driver `pg` devolve NUMERIC
 * como string por padrão em @mikro-orm/postgresql, então nenhuma conversão
 * para float acontece em nenhum ponto do pipeline.
 */
/**
 * `forceUtcTimezone` + `driverOptions` mantêm todo timestamp em UTC.
 * NUMERIC columns são lidas/escritas como string (nunca number) — ver
 * `columnType: 'numeric(18,2)'` nas entidades; o driver `pg` devolve NUMERIC
 * como string por padrão em @mikro-orm/postgresql, então nenhuma conversão
 * para float acontece em nenhum ponto do pipeline.
 *
 * SSL: bancos hospedados (Neon, RDS, Supabase etc.) normalmente exigem
 * TLS na conexão — a própria connection string do Neon já vem com
 * `?sslmode=require`. O driver `pg` nem sempre respeita esse parâmetro da
 * URL sozinho de forma consistente entre versões, então habilitamos TLS
 * explicitamente via `driverOptions` sempre que a URL sinalizar isso (ou
 * via `DATABASE_SSL=true` para forçar manualmente). `rejectUnauthorized:
 * false` é necessário porque o Neon usa uma cadeia de certificados que o
 * Node não valida por padrão sem CA customizada — mesma configuração
 * usada por qualquer app Node/Bun se conectando a Postgres serverless.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering';
const needsSsl = process.env.DATABASE_SSL === 'true' || /sslmode=require/.test(databaseUrl) || /neon\.tech/.test(databaseUrl);

export default defineConfig({
  clientUrl: databaseUrl,
  entities: [WalletOrmEntity, WagerTransactionOrmEntity, WalletLedgerEntryOrmEntity, InboxMessageOrmEntity, OutboxMessageOrmEntity],
  extensions: [Migrator],
  migrations: {
    path: 'src/database/migrations',
    transactional: true,
  },
  // Pool com múltiplas conexões simultâneas — sem isso, chamadas
  // concorrentes a `em.transactional()` (ex.: múltiplos publicadores de
  // outbox, ou o cenário de concorrência da seção 8) serializam por trás
  // dos panos esperando uma única conexão do driver ficar livre, o que
  // mascara bugs de concorrência real em vez de exercitá-los.
  //
  // Bancos serverless como o Neon fecham conexões ociosas mais
  // agressivamente que um Postgres local — `min: 0` evita manter
  // conexões "mortas" no pool que o Neon já derrubou do lado dele.
  pool: {
    min: needsSsl ? 0 : 2,
    max: 10,
  },
  driverOptions: needsSsl
    ? {
        connection: {
          ssl: { rejectUnauthorized: false },
        },
      }
    : undefined,
  forceUtcTimezone: true,
  debug: process.env.MIKRO_ORM_DEBUG === 'true',
});
