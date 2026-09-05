# Jungle Gaming — Processador de Apostas Distribuídas

Serviço financeiro distribuído que processa transações de apostas recebidas
de múltiplos provedores de jogos, com correção financeira, idempotência e
concorrência como requisitos de primeira classe. Ver `ARCHITECTURE.md` para
as decisões de design, trade-offs e limitações.

## Stack

Bun 1.x, TypeScript estrito, NestJS, PostgreSQL (hospedado no
[Neon](https://neon.tech)), SQS via LocalStack, MikroORM, Docker Compose.

## Banco de dados: Neon (Postgres hospedado)

Este projeto usa Postgres hospedado no Neon em vez de um container local
— nenhum outro código muda por causa disso, só a `DATABASE_URL` (ver
ARCHITECTURE.md §3 sobre por que a arquitetura hexagonal torna essa troca
trivial).

1. Crie uma conta gratuita em https://neon.tech e um novo projeto
2. No painel do projeto, vá em **Connection Details** e copie a
   connection string (formato `postgresql://usuario:senha@host/dbname?sslmode=require`)
3. Cole essa string na variável `DATABASE_URL` do seu `.env` (ver
   `.env.example`)

O `mikro-orm.config.ts` detecta automaticamente que a URL é do Neon (pela
presença de `sslmode=require` ou `neon.tech` na string) e habilita TLS na
conexão — nenhuma configuração manual extra é necessária.

> Se preferir rodar com um Postgres local em vez do Neon, basta trocar a
> `DATABASE_URL` para `postgresql://usuario:senha@localhost:5432/dbname`
> apontando para uma instância sua — o código funciona com qualquer
> Postgres compatível, com ou sem TLS.

## Subindo o ambiente completo

```
cp .env.example .env
# edite o .env com a DATABASE_URL do seu projeto Neon
docker compose up --build
```

Isso sobe, nesta ordem: localstack (com as filas
wager-transactions.fifo e wager-transactions-dlq.fifo já criadas via
docker/localstack-init/01-create-queues.sh) -> migrate (roda as
migrações contra o Neon) -> api + 2x sqs-worker + 2x outbox-worker +
pending-reference-worker.

O Postgres não faz mais parte do `docker-compose.yml` — é hospedado
externamente pelo Neon, então não há container nem volume local para o
banco.

A API fica disponível em http://localhost:3000.

## Rodando localmente sem Docker (apenas a API, contra infra já no ar)

```
bun install
bun run migration:up
bun run start:dev
```

Em processos separados, os workers:

```
bun run start:worker:sqs
bun run start:worker:outbox
bun run start:worker:pending-reference
```

## Testes

```
bun run test:unit          # dominio puro, sem infraestrutura - roda em qualquer lugar
bun run test:integration   # requer Postgres + LocalStack reais
bun run test:concurrency   # cenarios de concorrencia real contra Postgres
bun run test:all           # os tres acima
```

Nota sobre este repositório: todo o código foi escrito com type-check
(tsc --strict) 100% limpo em domínio, aplicação, infraestrutura,
apresentação e testes. As suítes de test/unit foram verificadas rodando a
lógica equivalente sob Node antes de virarem bun:test. As suítes de
test/integration e test/concurrency foram executadas de verdade contra
Postgres + LocalStack reais via docker compose — essa execução real
revelou 3 bugs de concorrência que não apareciam nos testes de unidade em
memória (corrida de idempotência sob concorrência real, backoff aplicado
antes da primeira tentativa de resolver referência, e pool de conexões do
banco não configurado explicitamente), todos corrigidos e documentados em
ARCHITECTURE.md §11.1. Rode as suítes SEPARADAMENTE (nunca combine
test/integration e test/concurrency num único comando `bun test`) — cada
`bun run test:*` abaixo é um processo isolado, o que evita duas suítes
disputando a mesma limpeza de tabelas ao mesmo tempo:

```
docker compose up -d localstack
bun run migration:up
bun run test:integration
bun run test:concurrency
```

## Migrações

```
bun run migration:up      # aplica
bun run migration:down    # reverte a ultima
```

Não há um comando `migration:create` automatizado (o CLI oficial do
MikroORM depende de `ts-node`, que não faz parte do stack Bun-first deste
projeto). Para adicionar uma nova migração, copie o padrão de
`src/database/migrations/Migration000X_*.ts` (classe estendendo
`Migration`, métodos `up()`/`down()` com `this.addSql(...)`) e nomeie o
arquivo seguindo a sequência numérica existente.

## Endpoints

- POST /wallets — cria carteira (crédito de abertura opcional, atômico)
- GET /wallets — lista todas as carteiras cadastradas, paginado por cursor (`?cursor=&limit=`) — não faz parte do desafio original
- GET /wallets/:walletId — consulta saldo/versão
- GET /players/:playerId/wallet?currency=BRL — consulta a carteira de um jogador (não faz parte do desafio original; conveniência para não precisar guardar o walletId separadamente)
- GET /wallets/:walletId/ledger?cursor=&limit= — extrato paginado (keyset cursor)
- POST /wallets/:walletId/reconciliation — recalcula saldo a partir do ledger e compara
- POST /wagering/transactions — submete uma transação de aposta (requer header Idempotency-Key)
- GET /wagering/transactions/:transactionId — consulta por id interno
- GET /providers/:providerId/wagering/transactions/:externalTransactionId — consulta por chave do provedor
- GET /health/live — liveness
- GET /health/ready — readiness (Postgres + SQS)
- GET /metrics — métricas Prometheus

Exemplo de submissão:

```
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

## Autenticação

Não implementada — decisão deliberada, documentada em detalhe na seção
correspondente de ARCHITECTURE.md. O ponto de extensão (AuthGuard no-op)
está identificado ali para quem quiser adicionar OIDC via Keycloak/Zitadel
depois.

## Estrutura do projeto

```
src/
  shared/            Money, FailureCode, IntegrationEvent, UnitOfWork, erros - sem dependencia de framework
  modules/
    wallets/          dominio, aplicacao, infraestrutura (MikroORM), apresentacao (HTTP) da Wallet
    wagering/         WagerTransaction, WalletLedgerEntry, casos de uso, controllers, consumer SQS
  messaging/          Inbox, Outbox, eventos de integracao, publisher
  database/           config MikroORM + migracoes versionadas
  config/             composicao manual de dependencias (bootstrap-context.ts) reutilizada por API e workers
  health/             liveness/readiness/metrics
test/
  unit/               dominio puro - bun:test, sem infraestrutura
  integration/        Postgres real (atomicidade, idempotencia, outbox)
  concurrency/        cenarios de corrida reais (secao 8), referencia fora de ordem (secao 7.1)
docker/localstack-init/  script de bootstrap das filas SQS FIFO + DLQ
```
