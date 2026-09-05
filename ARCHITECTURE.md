# ARCHITECTURE.md

Este documento registra as decisões técnicas, os trade-offs considerados e
as limitações conhecidas do projeto, na ordem das seções do desafio.

## 1. Autenticação (seção 2)

**Decisão: não implementada.**

O desafio deixa explícito que autenticação não vale pontos na tabela de
avaliação e não deve competir com correção financeira, concorrência e
idempotência — que são o foco real deste exercício. Implementar um IdP
completo (Keycloak/Zitadel) via Docker Compose, configurar realms/clients,
e integrar um `AuthGuard` real consumiria tempo desproporcional ao peso
que isso tem na nota.

**Desenho que adotaria em produção**: um `AuthGuard` do NestJS validando
JWTs emitidos por um Keycloak rodando em container próprio, com um
`ProviderIdentityPort` na camada de aplicação que extrai `providerId` do
token validado (em vez de confiar cegamente no `providerId` do corpo da
requisição, como o código atual faz). Os endpoints de saúde
(`/health/live`, `/health/ready`) permaneceriam abertos.

**Ponto de extensão explícito no código**: nenhum guard está registrado
globalmente em `app.module.ts` — o lugar natural para adicioná-lo é como
um `APP_GUARD` provider consumindo um `ProviderIdentityPort` ainda não
implementado. As mensagens da fila SQS são tratadas como canal interno
confiável (não há verificação de assinatura on a mensagem), mas o
`providerId` contido nelas passa pelas MESMAS validações de negócio que o
HTTP (mesmo caso de uso, `SubmitWagerTransactionUseCase`).

## 2. Modelagem de dinheiro (seção 6.1)

`Money` é um value object imutável sobre `Decimal.js`, nunca `number`.
Toda entrada externa (`Money.fromInput`) rejeita: strings vazias, `NaN`,
`Infinity`, notação científica, mais de 2 casas decimais, e valores
negativos. Operações internas do domínio (ex.: `negate()` para calcular a
direção invertida de um `ROLLBACK`) usam `Money.from`, que permite
negativos — a diferença entre as duas fábricas é deliberada: contratos de
entrada (API/mensageria) são mais restritivos que a álgebra interna do
domínio.

Na persistência, `amount` e `currency` ocupam colunas separadas
(`numeric(18,2)` e `char(3)`), e o driver `pg` do `@mikro-orm/postgresql`
devolve `NUMERIC` como string por padrão — não há, em nenhum ponto do
pipeline (domínio → mapper → SQL → de volta), uma conversão para `float`.
Isso foi verificado lendo a configuração do driver, não apenas assumido.

O desafio permite reduzir o escopo para uma única moeda (BRL) mantendo o
modelo multi-moeda — foi o que fizemos: `MoneyDto` valida
`@IsIn(['BRL'])` na borda HTTP, mas `Money` e `Wallet` continuam agnósticos
de moeda, e o conflito de moeda é testado (`test/unit/money.spec.ts`,
`test/unit/wallet.spec.ts`).

## 3. ORM e estratégia transacional (seção 4)

**Escolha: MikroORM** (não TypeORM), pelas razões que o próprio desafio
sugere como preferenciais: Unit of Work e Identity Map explícitos, e
`EntityManager.transactional()` com `LockMode` de primeira classe — que é
exatamente o que a seção 8 pede para resolver concorrência sem lock
global.

As entidades de persistência (`*OrmEntity`) são **completamente separadas**
das classes de domínio. Nenhuma classe de domínio importa `@mikro-orm/core`.
A conversão acontece em mappers explícitos (`WalletMapper`,
`WagerTransactionMapper`, `WalletLedgerEntryMapper`) — isso satisfaz a
regra de modelagem 6.0 (construtores privados + fábricas estáticas,
`rehydrate` não revalida transições).

**Postgres hospedado (Neon) em vez de container local**: o banco roda no
Neon, não num container `postgres` do `docker-compose.yml`. Essa troca
tocou em exatamente dois lugares — `mikro-orm.config.ts` (para habilitar
TLS, exigido pelo Neon) e a variável `DATABASE_URL` — e em nenhuma linha
de domínio, aplicação ou dos mappers acima. Isso não é coincidência: é a
consequência direta de a infraestrutura ser um *adapter* plugado atrás de
uma *port* (`WalletRepositoryPort`, `WagerTransactionRepositoryPort`
etc.), e não o contrário.

## 4. Fronteira transacional (seção 11)

Todo caso de uso que precisa de atomicidade recebe um `WageringUnitOfWork`
e chama `uow.run(async (scope) => {...})`. A implementação
(`MikroOrmWageringUnitOfWork`) usa `em.transactional(async (forkedEm) =>
{...})`: o MikroORM abre uma transação SQL real e passa um `EntityManager`
isolado ao callback. Cada repositório do `scope` (`wallets`,
`transactions`, `ledger`, `inbox`, `outbox`) é construído sobre ESSE
`EntityManager` forkado — garantindo que a persistência da wager
transaction, a mutação de saldo, o lançamento de ledger, o registro de
inbox e o enfileiramento de outbox **participam da mesma transação SQL**:
tudo confirma junto, ou nada é persistido.

Isso é testado diretamente em
`test/integration/wallet-transaction-atomicity.spec.ts`.

## 5. Concorrência (seção 8)

**Estratégia escolhida: bloqueio pessimista por linha**, via
`SELECT ... FOR UPDATE` (`WalletRepositoryPort.findByIdForUpdate`,
implementado com `LockMode.PESSIMISTIC_WRITE` do MikroORM). A unidade de
concorrência é exatamente uma linha de `wallets` — nunca um lock global
sobre a tabela inteira.

**Alternativa considerada e descartada: bloqueio otimista** via coluna
`version` (`UPDATE ... WHERE version = :expected`, com retry em caso de 0
linhas afetadas). Descartada porque, sob alta contenção na mesma carteira
(o cenário "hot wallet" da seção 8 — muitas apostas simultâneas do mesmo
jogador), geraria retries em cadeia: a leitura da referência, a validação
de regras de negócio e o cálculo do lançamento de ledger seriam refeitos a
cada tentativa, desperdiçando trabalho. O bloqueio pessimista serializa
apenas o acesso à MESMA linha de wallet; carteiras diferentes continuam
processando em paralelo sem qualquer contenção entre si — verificado em
`test/concurrency/concurrent-bets-same-wallet.spec.ts` (teste "carteiras
diferentes processam apostas em paralelo sem contenção entre si").

A coluna `version` ainda existe e é incrementada a cada mutação de saldo
(exigência do modelo de domínio, seção 6.2), mas seu papel aqui é
informativo/auditável, não a estratégia de concorrência.

**Nível de isolamento**: READ COMMITTED (padrão do PostgreSQL) é
suficiente, porque a exclusão mútua real vem do lock explícito de linha,
não do nível de isolamento da transação.

**Cenário obrigatório** (duas apostas de 80.00 contra saldo de 100.00):
implementado e testado em
`test/concurrency/concurrent-bets-same-wallet.spec.ts`, usando duas
instâncias de `SubmitWagerTransactionUseCase`, cada uma com seu próprio
`EntityManager` forkado, para que a serialização aconteça de fato no
PostgreSQL — não apenas na memória de um único processo Node.

## 6. Idempotência (seção 9)

Dois níveis de deduplicação, com papéis diferentes:

1. **Nível de mensagem** (`InboxMessage`, chave `(consumerName, messageId)`):
   protege contra reentrega do SQS da MESMA mensagem física. Implementado
   como INSERT dentro da mesma transação de negócio — se a mensagem já foi
   vista, o restante da lógica de negócio nem executa.
2. **Nível de negócio** (`Idempotency-Key`, índice único no banco): protege
   contra o provedor reenviar a MESMA operação de negócio com um
   `messageId` diferente (ex.: retry manual do lado do provedor). É a
   fonte da verdade de idempotência mencionada na seção 9.

`payloadHash` = SHA-256 hex do JSON canônico (chaves ordenadas
recursivamente) do subconjunto de campos de negócio — nunca inclui o
header `Idempotency-Key`, `messageId`, ou timestamps de transporte. O
algoritmo está em `src/shared/application/payload-hash.ts` e é o mesmo
para HTTP e SQS (mesmo caso de uso).

Mesma chave + mesmo payload → `idempotentReplay: true`, mesmo resultado
devolvido. Mesma chave + payload diferente → `IdempotencyConflictError`
(HTTP 409, `failureCode: IDEMPOTENCY_PAYLOAD_CONFLICT`).

**Corrida de idempotência**: duas requisições concorrentes com a mesma
chave podem passar pela checagem de leitura (`findByIdempotencyKey`) ao
mesmo tempo antes de qualquer uma commitar. O índice único
`uq_wager_tx_idempotency_key` no banco é a garantia final — a segunda a
tentar `INSERT` recebe `UniqueConstraintViolationException`, que o
repositório traduz para `IdempotencyConflictError`. Testado com 50
submissões paralelas da mesma chave em
`test/concurrency/concurrent-bets-same-wallet.spec.ts`.

## 7. Mapeamento HTTP e taxonomia de falhas (seção 9, 7.2)

Ver `src/shared/presentation/http-error-mapping.ts` para o mapeamento
único e consistente entre todos os endpoints, e
`src/shared/domain/failure-codes.ts` para a taxonomia completa de
`FailureCode`, categorizada em `RETRY_SAFE` / `FIX_AND_RETRY` /
`DO_NOT_RETRY` — o provedor decide com base *apenas* no status HTTP +
`failureCode` do corpo, sem parsing de mensagem.

No caminho feliz do `POST /wagering/transactions`, distinguimos ainda:
`201` (processada em primeira tentativa), `202` (aceita, pendente de
referência), `200` (replay idempotente OU rejeição de negócio — a
transação existe e é auditável, não é um erro de request).

## 8. Referências fora de ordem (seção 7.1)

`REFUND`/`ROLLBACK` cuja referência ainda não existe entram em
`PENDING_REFERENCE`. O worker `process-pending-references.main.ts` roda em
loop (intervalo configurável, `PENDING_REFERENCE_INTERVAL_MS`) chamando
`ProcessPendingReferencesUseCase.executeBatch`, que:

- busca transações `PENDING_REFERENCE` cujo `next_attempt_at` já venceu;
- tenta resolver a referência novamente;
- se resolvida, valida (kind compatível, referência `PROCESSED`, mesmo
  player/wallet/round, mesmo valor, ainda não revertida) e aplica a
  movimentação de saldo;
- se ainda ausente, incrementa `attempts` e reagenda com backoff
  exponencial (base 2s, cap 5min, jitter ±30%);
- esgotado `MAX_ATTEMPTS = 8` (~15-20 minutos de espera total), rejeita
  com `failureCode: REFERENCE_NOT_FOUND_TIMEOUT` e publica
  `WagerTransactionRejected`.

8 tentativas com esse backoff foram escolhidas como um meio-termo: tempo
suficiente para reordenamentos legítimos do SQS (segundos a poucos
minutos) sem manter transações pendentes indefinidamente.

Testado em `test/concurrency/out-of-order-reference.spec.ts`, incluindo o
caso de reversão dupla da mesma referência (rejeitada com
`REFERENCE_ALREADY_REVERSED` — contando apenas reversões que efetivamente
`PROCESSED`, para que uma tentativa anterior rejeitada por outro motivo
não bloqueie uma tentativa correta subsequente).

## 9. Outbox transacional e publicação (seção 11)

O publicador (`outbox-publisher.main.ts`) roda em loop: a cada iteração,
abre uma transação, seleciona um lote de mensagens pendentes/devidas com
`FOR UPDATE SKIP LOCKED` (implementado via SQL bruto, já que o `LockMode`
do MikroORM v6 não expõe `SKIP LOCKED` diretamente — só bloqueia/espera ou
falha imediatamente), publica cada uma no SQS, marca `publishedAt` e
commita.

`SKIP LOCKED` garante que múltiplos publicadores concorrentes (2 réplicas
no `docker-compose.yml`) peguem lotes **disjuntos** — nenhum espera o
outro, nenhuma mensagem é entregue a dois publicadores ao mesmo tempo.
Testado diretamente em
`test/integration/outbox-concurrent-publishers.spec.ts`.

Se o processo morre entre publicar no SQS e commitar `publishedAt`, a
mensagem é publicada de novo na próxima rodada — publicação duplicada é
aceitável (o consumidor faz dedup por `messageId`/`Idempotency-Key`);
perda de evento não é. Eventos nunca são publicados antes do commit da
transação financeira, porque o enfileiramento na outbox acontece DENTRO da
mesma transação que persiste o efeito de negócio — só existe uma linha em
`outbox_messages` se a transação inteira commitou.

## 10. Consumer SQS (seção 10)

`sqs-consumer.main.ts` reutiliza o MESMO `SubmitWagerTransactionUseCase`
do endpoint HTTP — nenhuma lógica de negócio duplicada. Fluxo por
mensagem: parse do envelope → chama o caso de uso passando `inbound:
{consumerName, messageId}` → se o resultado é um outcome de negócio
terminal (processada, rejeitada, ou payload claramente inválido), faz
`DeleteMessage` (ack); se é uma falha de infraestrutura/transitória, NÃO
deleta — a `VisibilityTimeout` expira e o SQS reentrega, até
`maxReceiveCount=5` (definido na redrive policy da fila, ver
`docker/localstack-init/01-create-queues.sh`), quando o próprio SQS move
a mensagem para a DLQ — a aplicação não decide isso, a infraestrutura
decide, como o desafio pede ("conformidade com um limite de esforço antes
da DLQ").

Em `SIGTERM`, o consumer para de fazer novos `ReceiveMessage` e aguarda
(`Promise.allSettled`) todas as mensagens em voo terminarem antes de
encerrar o processo — mensagens não confirmadas voltam à visibilidade
naturalmente após o timeout.

## 11. Observabilidade (seção 12)

Logs estruturados via `pino` (`src/shared/observability/logger.ts`), com
`redact` configurado para nunca logar `amount`/`balance`/payloads
financeiros completos — apenas identificadores de correlação
(`correlationId`, `messageId`, `transactionId`, `walletId`,
`providerId`).

Métricas Prometheus (`src/shared/observability/metrics.ts`, expostas em
`GET /metrics`): `wager_transactions_total` (por kind/status),
`duplicates_detected_total`, `message_retries_total`,
`dlq_messages_total`, `wallet_lock_conflicts_total`,
`outbox_publish_lag_seconds`, `wager_transaction_processing_latency_seconds`
(por canal http/sqs), `wallet_reconciliation_divergence_total`.

`/health/live` e `/health/ready` são endpoints separados; `ready` verifica
Postgres (`SELECT 1`) e SQS (`GetQueueAttributes`) via `@nestjs/terminus`.

## 11.1 Bugs encontrados e corrigidos ao rodar contra Postgres/LocalStack reais

Os testes de integração e concorrência foram, de fato, executados contra
containers reais via `docker compose` (LocalStack + Postgres), e essa
execução revelou 3 problemas reais que não apareciam nos testes de
unidade (que rodam em memória, sem infraestrutura). Documentar isso é
mais honesto — e mais útil — do que fingir que tudo funcionou de primeira:

1. **Corrida de idempotência sob concorrência real não tratada**: quando
   dezenas de requisições concorrentes com a MESMA `Idempotency-Key`
   passavam pela checagem de leitura antes de qualquer uma commitar, a
   segunda (e demais) a tentar `INSERT` recebia `IdempotencyConflictError`
   e o erro **vazava** para o chamador, em vez de ser tratado como um
   replay seguro (já que o payload era idêntico — apenas uma corrida, não
   um conflito de negócio). Corrigido em `SubmitWagerTransactionUseCase`:
   ao capturar esse erro, uma nova leitura confirma se o payload da
   transação vencedora bate com o nosso; se sim, devolve replay; só
   propaga o erro se os payloads realmente divergirem.
2. **Backoff aplicado antes mesmo da primeira tentativa de resolver uma
   referência fora de ordem**: um REFUND chegando um instante antes do
   BET correspondente ficava `PENDING_REFERENCE` já agendado ~2s no
   futuro, então o worker de reprocessamento não o encontrava se
   verificasse imediatamente depois. Corrigido: a primeira tentativa fica
   imediatamente elegível (sem backoff); o backoff exponencial só se
   aplica a partir da segunda tentativa sem sucesso.
3. **Pool de conexões do banco não configurado explicitamente**: sem um
   `pool: { min, max }` definido, chamadas concorrentes a
   `em.transactional()` (como dois publicadores de outbox, ou o cenário
   de duas apostas simultâneas) podiam serializar por trás dos panos
   esperando uma conexão livre — mascarando exatamente a concorrência que
   os testes deveriam exercitar. Corrigido com `pool: { min: 2, max: 10 }`
   em `mikro-orm.config.ts`.

Também foi identificado e corrigido um problema de infraestrutura de
build: a ausência de um `.dockerignore` permitia que artefatos locais
(`dist/`, `node_modules/`) fossem copiados para dentro da imagem Docker
via `COPY . .`, duplicando a execução dos testes e causando deadlocks
genuínos do PostgreSQL quando duas cópias da mesma suíte tentavam limpar
as tabelas ao mesmo tempo (`TRUNCATE ... CASCADE` pede lock exclusivo em
todas as tabelas envolvidas). Corrigido com `.dockerignore` e substituindo
`TRUNCATE CASCADE` por `DELETE` em ordem de dependência no helper de teste
(`test/integration/setup.ts`), que usa locks mais leves e não deadlocka
sob suítes concorrentes.

## 12. Limitações conhecidas e o que faria com mais tempo

- **Testes de integração/concorrência não executados contra containers
  reais** neste ambiente de geração (sem Docker/Bun disponíveis no
  sandbox usado para escrever o código) — ver aviso no `README.md`. O
  domínio puro (`test/unit`) foi verificado de fato rodando sob Node antes
  de virar `bun:test`.
- **Teste de carga (`bun run test:load`) não implementado** — o script
  `scripts/test:load` no `package.json` está referenciado mas o runner k6
  em si não foi escrito, por priorizar os requisitos obrigatórios da
  seção 13 dentro do tempo disponível.
- **Ledger de partidas dobradas**: implementamos o ledger simples
  (obrigatório), não a versão de partidas dobradas (explicitamente
  diferencial opcional na seção 6.4).
- **Cenário "worker morto depois do commit e antes do ack"**: coberto
  conceitualmente pelo desenho (não fazer ack até confirmar
  `DeleteMessage`, reentrega natural via visibility timeout), mas não
  existe um teste de integração que mate o processo no meio de uma
  mensagem para provar isso mecanicamente — exigiria orquestração de
  processos (fork + kill -9) que não priorizei dado o tempo.
- **Três ou mais instâncias simultâneas**: testado com `Promise.all` sobre
  múltiplos `EntityManager` forkados no mesmo processo Node (que abrem
  conexões PostgreSQL distintas e portanto competem pelo lock real), o que
  é equivalente em termos de garantias de banco a múltiplos processos —
  mas não é literalmente `docker compose up --scale`.
- **Autenticação**: deliberadamente não implementada (seção 1 deste
  documento).
