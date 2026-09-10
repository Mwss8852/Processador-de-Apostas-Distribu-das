# ARCHITECTURE.md

Este documento registra as decisões técnicas, os trade-offs considerados, os problemas encontrados durante a validação e as limitações conhecidas do projeto, seguindo a ordem das seções relevantes do desafio.

## 1. Autenticação (seção 2)

**Decisão: não implementada.**

O desafio deixa explícito que autenticação não vale pontos na tabela de avaliação e não deve competir com correção financeira, concorrência e idempotência — que são o foco real deste exercício. Implementar um IdP completo (Keycloak/Zitadel) via Docker Compose, configurar realms/clients e integrar um `AuthGuard` real consumiria tempo desproporcional ao peso que isso tem na nota.

**Desenho que seria adotado em produção:** um `AuthGuard` do NestJS validando JWTs emitidos por um Keycloak rodando em container próprio, com um `ProviderIdentityPort` na camada de aplicação que extrai `providerId` do token validado, em vez de confiar cegamente no `providerId` do corpo da requisição, como ocorre atualmente.

Os endpoints de saúde (`/health/live`, `/health/ready`) permaneceriam abertos.

**Ponto de extensão explícito no código:** nenhum guard está registrado globalmente em `app.module.ts`. O lugar natural para adicioná-lo seria como um `APP_GUARD` provider consumindo um `ProviderIdentityPort`.

As mensagens da fila SQS são tratadas como provenientes de um canal interno controlado pela infraestrutura da aplicação. Não há validação criptográfica ou assinatura individual das mensagens neste desafio. O `providerId` contido nelas, entretanto, passa pelas mesmas validações de negócio que o HTTP, pois ambos utilizam o mesmo caso de uso: `SubmitWagerTransactionUseCase`.

---

## 2. Modelagem de dinheiro (seção 6.1)

`Money` é um value object imutável sobre `Decimal.js`, nunca `number`.

Toda entrada externa (`Money.fromInput`) rejeita:

* strings vazias;
* `NaN`;
* `Infinity`;
* notação científica;
* mais de 2 casas decimais;
* valores negativos.

Operações internas do domínio, como `negate()` para calcular a direção invertida de um `ROLLBACK`, utilizam `Money.from`, que permite valores negativos.

A diferença entre as duas fábricas é deliberada: contratos de entrada da API e mensageria são mais restritivos que a álgebra interna do domínio.

Na persistência, `amount` e `currency` ocupam colunas separadas (`numeric(18,2)` e `char(3)`).

O driver `pg` do `@mikro-orm/postgresql` devolve `NUMERIC` como string por padrão. Não há, em nenhum ponto do pipeline — domínio, mapper, SQL ou retorno da persistência — conversão do valor monetário para `float`.

O desafio permite reduzir o escopo para uma única moeda (BRL) mantendo o modelo multi-moeda. Foi essa a decisão adotada: `MoneyDto` valida `@IsIn(['BRL'])` na borda HTTP, enquanto `Money` e `Wallet` continuam agnósticos de moeda.

A validação do código de moeda em `Money.from()` é feita contra um conjunto real de códigos ISO-4217 alpha-3, não apenas contra o formato de 3 letras maiúsculas — uma regex de formato (`/^[A-Z]{3}$/`) aceitaria códigos inexistentes (ex.: `"REA"`), o que quebraria a garantia de que toda `Money` no sistema representa uma moeda real (ver seção 12, item 7).

Conflitos de moeda também são testados em:

* `test/unit/money.spec.ts`
* `test/unit/wallet.spec.ts`

---

## 3. ORM e estratégia transacional (seção 4)

**Escolha: MikroORM.**

A escolha foi feita pelas características que o próprio desafio sugere como preferenciais: Unit of Work, Identity Map e `EntityManager.transactional()` com `LockMode` de primeira classe.

Esses recursos são utilizados para implementar a estratégia de concorrência exigida pela seção 8 sem utilizar lock global.

As entidades de persistência (`*OrmEntity`) são completamente separadas das classes de domínio.

Nenhuma classe de domínio importa `@mikro-orm/core`.

A conversão entre persistência e domínio acontece através de mappers explícitos:

* `WalletMapper`
* `WagerTransactionMapper`
* `WalletLedgerEntryMapper`

Essa separação mantém o domínio independente da infraestrutura e atende à regra de modelagem da seção 6.0, incluindo construtores privados, fábricas estáticas e `rehydrate` sem revalidação indevida das transições de estado.

**PostgreSQL:** o projeto utiliza PostgreSQL como banco de dados relacional e a conexão é definida pela variável `DATABASE_URL`. A infraestrutura de persistência permanece isolada atrás das portas da aplicação (`WalletRepositoryPort`, `WagerTransactionRepositoryPort` etc.), permitindo alterar a origem do PostgreSQL sem modificar o domínio ou os casos de uso.

O ambiente de validação utilizou um Postgres hospedado (Neon), habilitando TLS via `driverOptions` e ajustando o pool de conexões para lidar com as características de um banco serverless (ver seção 12, item 3, e detalhes de `pool.min`/`pool.max` em `mikro-orm.config.ts`).

---

## 4. Fronteira transacional (seção 11)

Todo caso de uso que precisa de atomicidade recebe um `WageringUnitOfWork` e chama:

```text
uow.run(async (scope) => {...})
```

A implementação (`MikroOrmWageringUnitOfWork`) utiliza:

```text
em.transactional(async (forkedEm) => {...})
```

O MikroORM abre uma transação SQL real e fornece um `EntityManager` isolado ao callback.

Cada repositório do `scope`:

* `wallets`
* `transactions`
* `ledger`
* `inbox`
* `outbox`

é construído sobre esse `EntityManager` forkado.

Dessa forma, a persistência da wager transaction, a alteração do saldo, o lançamento no ledger, o registro do inbox e o enfileiramento na outbox participam da mesma transação SQL.

Tudo confirma junto ou nada é persistido.

Essa atomicidade é coberta pelo teste:

```text
test/integration/wallet-transaction-atomicity.spec.ts
```

O teste de integração foi executado contra PostgreSQL real, validando a fronteira transacional fora de mocks de memória.

---

## 5. Concorrência (seção 8)

**Estratégia escolhida: bloqueio pessimista por linha.**

A estratégia utiliza `SELECT ... FOR UPDATE`, através de:

```text
WalletRepositoryPort.findByIdForUpdate
```

implementado com `LockMode.PESSIMISTIC_WRITE` do MikroORM.

A unidade de concorrência é exatamente uma linha da tabela `wallets`.

Não existe lock global sobre a tabela.

### Alternativa considerada

Foi considerada a utilização de bloqueio otimista através da coluna `version`:

```text
UPDATE ... WHERE version = :expected
```

com retry em caso de nenhuma linha afetada.

Essa abordagem foi descartada porque, sob alta contenção na mesma carteira — o cenário de uma hot wallet — poderia gerar uma cadeia de retries.

Nesse cenário, a leitura da referência, a validação das regras de negócio e o cálculo do lançamento do ledger precisariam ser refeitos a cada tentativa.

O bloqueio pessimista serializa apenas o acesso à mesma linha de wallet.

Carteiras diferentes continuam podendo ser processadas em paralelo sem contenção entre si.

A coluna `version` continua existindo e é incrementada a cada mutação de saldo, conforme exigido pelo modelo de domínio. Seu papel, entretanto, é informativo e auditável, e não representa a estratégia principal de concorrência.

### Nível de isolamento

O projeto utiliza `READ COMMITTED`, padrão do PostgreSQL.

Esse nível é suficiente porque a exclusão mútua necessária para a alteração do saldo é garantida pelo lock explícito da linha da wallet.

### Cenário obrigatório

O cenário exigido pelo desafio:

```text
Saldo inicial: 100.00 BRL

BET 80.00
BET 80.00
```

foi implementado e executado em:

```text
test/concurrency/concurrent-bets-same-wallet.spec.ts
```

O teste utiliza instâncias independentes de `EntityManager` forkado para que a competição aconteça através do PostgreSQL e não apenas dentro da memória de um único processo Node.

O resultado esperado é:

```text
BET 1 → PROCESSED
BET 2 → REJECTED / insufficient funds

Saldo final → 20.00 BRL
Ledger       → 1 débito
```

Esse cenário foi validado durante a execução dos testes de concorrência.

---

## 6. Idempotência (seção 9)

O projeto utiliza dois níveis de deduplicação, com responsabilidades diferentes.

### 1. Nível de mensagem

`InboxMessage`, através da chave:

```text
(consumerName, messageId)
```

protege contra a reentrega da mesma mensagem física pelo SQS.

O registro é realizado dentro da mesma transação da operação de negócio.

Se a mensagem já foi processada, a lógica de negócio não é executada novamente.

### 2. Nível de negócio

O `Idempotency-Key`, protegido por índice único no banco de dados, protege contra o provedor reenviar a mesma operação de negócio utilizando um `messageId` diferente.

Esse mecanismo é a fonte de verdade da idempotência da operação.

O `payloadHash` é calculado utilizando SHA-256 sobre o JSON canônico do subconjunto de campos de negócio.

As chaves são ordenadas recursivamente.

O hash não inclui:

* `Idempotency-Key`;
* `messageId`;
* timestamps de transporte.

O algoritmo está implementado em:

```text
src/shared/application/payload-hash.ts
```

e é utilizado tanto pelo HTTP quanto pelo SQS, pois ambos passam pelo mesmo caso de uso.

### Resultado

Mesma chave + mesmo payload:

```text
idempotentReplay: true
```

e o mesmo resultado da operação original é devolvido.

Mesma chave + payload diferente:

```text
HTTP 409
failureCode: IDEMPOTENCY_PAYLOAD_CONFLICT
```

### Corrida de idempotência

Duas requisições concorrentes com a mesma chave podem passar simultaneamente pela consulta inicial de idempotência antes que qualquer uma delas faça commit.

O índice único:

```text
uq_wager_tx_idempotency_key
```

é a garantia final do banco.

Quando uma requisição consegue inserir primeiro, as demais podem receber `UniqueConstraintViolationException`.

O caso de uso trata essa situação realizando uma nova leitura da transação vencedora.

Se o `payloadHash` for igual ao payload atual, a requisição é tratada como replay idempotente.

Somente quando os payloads forem diferentes o erro `IdempotencyConflictError` é propagado.

Esse comportamento foi validado com submissões concorrentes utilizando a mesma chave de idempotência.

---

## 7. Mapeamento HTTP e taxonomia de falhas (seção 9, 7.2)

Ver:

```text
src/shared/presentation/http-error-mapping.ts
```

para o mapeamento único e consistente entre os endpoints.

A taxonomia completa está em:

```text
src/shared/domain/failure-codes.ts
```

e categoriza os códigos de falha em:

* `RETRY_SAFE`
* `FIX_AND_RETRY`
* `DO_NOT_RETRY`

O provedor pode tomar sua decisão utilizando apenas o status HTTP e o `failureCode` retornado no corpo, sem depender do parsing de mensagens textuais.

No caminho feliz do:

```text
POST /wagering/transactions
```

são distinguidos:

* `201` — transação processada em primeira tentativa;
* `202` — transação aceita, porém pendente de referência;
* `200` — replay idempotente ou rejeição de negócio.

Nos dois últimos casos, a transação existe e permanece auditável.

---

## 8. Referências fora de ordem (seção 7.1)

`REFUND` ou `ROLLBACK` cuja referência ainda não existe entram no estado:

```text
PENDING_REFERENCE
```

O worker:

```text
process-pending-references.main.ts
```

executa em loop utilizando o intervalo configurável:

```text
PENDING_REFERENCE_INTERVAL_MS
```

e chama:

```text
ProcessPendingReferencesUseCase.executeBatch
```

O processamento:

1. busca transações `PENDING_REFERENCE` cujo `next_attempt_at` já venceu;
2. tenta resolver a referência novamente;
3. se a referência existir, valida:

   * kind compatível;
   * referência `PROCESSED`;
   * mesmo player;
   * mesma wallet;
   * mesmo round;
   * mesmo valor;
   * referência ainda não revertida;
4. aplica a movimentação de saldo quando todas as validações são satisfeitas;
5. caso a referência continue ausente, incrementa `attempts` e agenda uma nova tentativa.

A primeira tentativa é imediatamente elegível.

O backoff exponencial é aplicado somente a partir da segunda tentativa sem sucesso.

A estratégia utiliza base de 2 segundos, limite de 5 minutos e jitter de aproximadamente ±30%.

Após `MAX_ATTEMPTS = 8`, a operação é rejeitada com:

```text
REFERENCE_NOT_FOUND_TIMEOUT
```

e um evento `WagerTransactionRejected` é publicado.

O comportamento foi validado no teste:

```text
test/concurrency/out-of-order-reference.spec.ts
```

incluindo o cenário de tentativa de reversão dupla da mesma referência.

Uma segunda reversão é rejeitada com:

```text
REFERENCE_ALREADY_REVERSED
```

considerando apenas reversões que efetivamente chegaram ao estado `PROCESSED`.

---

## 9. Outbox transacional e publicação (seção 11)

O publicador:

```text
outbox-publisher.main.ts
```

executa em loop.

A cada iteração, abre uma transação e seleciona um lote de mensagens pendentes ou devidas utilizando `FOR UPDATE SKIP LOCKED`, através de `em.find()` com `lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE` — o mapeamento nativo do MikroORM v6 para `SKIP LOCKED` no driver Postgres.

> Uma versão anterior desta seleção usava SQL bruto via `em.getConnection().execute(...)`, por uma suposição incorreta de que o MikroORM não expunha `SKIP LOCKED` através de `LockMode`. Essa implementação continha um bug real (ver seção 12, item 5): a query não participava da transação aberta por `em.transactional()`, permitindo que dois publicadores concorrentes obtivessem o mesmo lote. A implementação atual usa a API nativa do EntityManager, que já está corretamente vinculada ao contexto de transação ativo.

O `SKIP LOCKED` permite que múltiplos publicadores concorrentes selecionem lotes disjuntos de registros da outbox, evitando que um publicador fique esperando pelo lock mantido por outro.

Isso permite executar múltiplas réplicas do publicador sem que elas trabalhem simultaneamente sobre as mesmas linhas.

Após publicar a mensagem no SQS, o registro é marcado com `publishedAt` e a transação é confirmada.

### Falha entre publicação e commit

Existe uma janela inevitável entre:

```text
publicar no SQS
        ↓
marcar publishedAt
        ↓
commit
```

Se o processo morrer depois da publicação e antes do commit, a mensagem poderá ser publicada novamente em uma próxima rodada.

Essa duplicação é aceitável e faz parte do desenho.

O consumidor utiliza idempotência por `messageId` e `Idempotency-Key`, impedindo que a duplicação provoque uma segunda aplicação financeira.

O ponto importante é que eventos não são publicados antes do commit da transação financeira.

O registro da outbox acontece dentro da mesma transação que persiste o efeito de negócio.

Portanto:

```text
Transação financeira não commitou
        ↓
Outbox não existe

Transação financeira commitou
        ↓
Outbox também existe
```

Esse comportamento foi validado pelo teste:

```text
test/integration/outbox-concurrent-publishers.spec.ts
```

O teste de disputa de linha entre publicadores concorrentes usa uma barreira de sincronização explícita (uma Promise resolvida no instante em que a primeira transação confirma ter adquirido seus locks) em vez de depender apenas do timing implícito de `Promise.all`, porque a latência de rede real contra um Postgres hospedado (Neon) pode fazer uma transação completar inteiramente antes da outra começar, mascarando a garantia de `SKIP LOCKED` que o teste pretende validar (ver seção 12, item 6).

---

## 10. Consumer SQS (seção 10)

O:

```text
sqs-consumer.main.ts
```

reutiliza o mesmo:

```text
SubmitWagerTransactionUseCase
```

utilizado pelo endpoint HTTP.

Não existe duplicação da lógica de negócio entre os dois canais.

O fluxo de cada mensagem é:

```text
parse do envelope
      ↓
SubmitWagerTransactionUseCase
      ↓
resultado
```

Quando o resultado é um outcome terminal de negócio — processada, rejeitada ou payload claramente inválido — a mensagem é confirmada através de `DeleteMessage`.

Quando ocorre uma falha transitória ou de infraestrutura, a mensagem não é deletada.

Nesse caso:

```text
VisibilityTimeout
       ↓
SQS reentrega
       ↓
novas tentativas
       ↓
DLQ após maxReceiveCount
```

O limite:

```text
maxReceiveCount = 5
```

é definido na redrive policy da fila em:

```text
docker/localstack-init/01-create-queues.sh
```

A aplicação não decide diretamente quando enviar uma mensagem para a DLQ.

Esse comportamento fica sob responsabilidade da infraestrutura do SQS, conforme o requisito do desafio.

### Graceful shutdown

Durante `SIGTERM`, o consumer:

1. interrompe novos `ReceiveMessage`;
2. aguarda as mensagens que ainda estão em processamento;
3. utiliza `Promise.allSettled`;
4. encerra o processo somente após finalizar as mensagens em voo.

Mensagens não confirmadas permanecem sujeitas à reentrega natural após o término do `VisibilityTimeout`.

---

## 11. Observabilidade (seção 12)

Os logs são estruturados utilizando `pino`.

A configuração de `redact` impede que valores financeiros sensíveis sejam registrados nos logs.

Não são registrados:

* `amount`;
* `balance`;
* payloads financeiros completos.

São registrados apenas identificadores necessários para correlação e diagnóstico, como:

* `correlationId`;
* `messageId`;
* `transactionId`;
* `walletId`;
* `providerId`.

As métricas Prometheus são expostas em:

```text
GET /metrics
```

Entre as métricas implementadas estão:

```text
wager_transactions_total
duplicates_detected_total
message_retries_total
dlq_messages_total
wallet_lock_conflicts_total
outbox_publish_lag_seconds
wager_transaction_processing_latency_seconds
wallet_reconciliation_divergence_total
```

A latência de processamento diferencia os canais:

```text
http
sqs
```

Os endpoints de saúde são separados:

```text
/health/live
/health/ready
```

`/health/ready` verifica a disponibilidade do PostgreSQL através de `SELECT 1` e a disponibilidade do SQS através de `GetQueueAttributes`, utilizando `@nestjs/terminus`.

---

## 12. Bugs encontrados e corrigidos durante a validação

Durante a validação do projeto foram identificados problemas relacionados à concorrência, idempotência e infraestrutura que não apareciam nos testes unitários executados apenas em memória.

Esses problemas foram analisados, corrigidos e posteriormente validados através dos testes de integração e concorrência utilizando a infraestrutura real do projeto (Postgres real, hospedado no Neon, e LocalStack).

### Corrida de idempotência sob concorrência real

Quando várias requisições com a mesma `Idempotency-Key` passavam pela verificação inicial antes de qualquer uma realizar o commit, as requisições concorrentes podiam receber `UniqueConstraintViolationException`.

O problema era que essa exceção inicialmente era tratada apenas como conflito e poderia vazar para o chamador, mesmo quando se tratava de uma corrida legítima com payload idêntico.

A correção foi realizada em `SubmitWagerTransactionUseCase`.

Ao capturar a violação de unicidade, o caso de uso realiza uma nova leitura da transação vencedora.

Se o `payloadHash` for igual, a requisição é tratada como replay idempotente.

Se o payload for diferente, o conflito real é propagado.

Esse comportamento foi validado com múltiplas submissões concorrentes utilizando a mesma chave.

### Backoff aplicado antes da primeira tentativa

Foi identificado que um `REFUND` ou `ROLLBACK` chegando imediatamente antes da operação de referência poderia ser colocado em `PENDING_REFERENCE` já agendado para aproximadamente 2 segundos no futuro.

Isso fazia com que uma execução imediata do worker não encontrasse a transação.

A correção foi fazer com que a primeira tentativa fique imediatamente elegível.

O backoff exponencial passa a ser utilizado somente após uma tentativa sem sucesso.

### Pool de conexões

O pool de conexões do banco não estava configurado explicitamente.

Isso poderia fazer com que operações concorrentes aguardassem uma conexão disponível e, em determinadas condições, mascarassem o comportamento de concorrência que os testes deveriam validar.

Foi adicionada a configuração:

```text
pool:
  min: 2 (0 quando conectando via TLS/Neon, ver mikro-orm.config.ts)
  max: 10
```

em `mikro-orm.config.ts`.

### Problema de infraestrutura no Docker

Também foi identificado um problema de build causado pela ausência de `.dockerignore`.

Sem o `.dockerignore`, artefatos locais como:

```text
dist/
node_modules/
```

podiam ser copiados para dentro da imagem através do:

```text
COPY . .
```

Isso poderia resultar na execução duplicada de artefatos de teste dentro do container.

Em determinadas situações, duas cópias da mesma suíte tentavam limpar as tabelas simultaneamente e podiam gerar deadlocks no PostgreSQL.

O problema foi corrigido com a criação do `.dockerignore`.

O helper de testes em:

```text
test/integration/setup.ts
```

também foi ajustado, substituindo `TRUNCATE ... CASCADE` por exclusões com `DELETE` na ordem das dependências, reduzindo a possibilidade de contenção desnecessária durante a preparação dos testes.

### Trigger de imutabilidade do ledger bloqueava a limpeza de testes

A correção anterior (troca de `TRUNCATE ... CASCADE` por `DELETE` no helper de teste) não previu que `wallet_ledger_entries` possui um trigger (`forbid_ledger_mutation()`) que rejeita qualquer `DELETE`/`UPDATE` na tabela — comportamento correto para produção, já que o ledger é append-only por desenho (seção 6.2 do desafio), mas incompatível com a estratégia de limpeza escolhida para os testes.

A primeira tentativa de correção — fazer a função retornar `NULL` quando uma flag de sessão estivesse ativa — revelou um segundo problema mais sutil: em um trigger `BEFORE DELETE` do PostgreSQL, retornar `NULL` **cancela silenciosamente a operação** em vez de permiti-la. O `DELETE` não gerava erro, mas também não apagava nenhuma linha, causando falhas de foreign key em cascata nos `DELETE`s seguintes do helper de limpeza.

Corrigido fazendo a função retornar `OLD` (para `DELETE`) ou `NEW` (para `UPDATE`) quando a flag `app.allow_ledger_cleanup` está ativa. Essa flag é setada localmente à transação de limpeza de teste via `set_config('app.allow_ledger_cleanup', 'true', true)` — o terceiro argumento `true` garante que ela é local à transação (`is_local`), e portanto nunca vaza para fora do escopo do teste nem afeta o comportamento em produção.

### `FOR UPDATE SKIP LOCKED` não participava da transação real

A implementação original de `lockDueBatchForUpdate` (repositório da outbox) executava SQL bruto via `em.getConnection().execute(query, params)`, por uma suposição incorreta de que o MikroORM v6 não expunha `SKIP LOCKED` através de `LockMode`. Essa chamada não estava vinculada à transação aberta por `em.transactional()` — o lock de linha era adquirido e liberado dentro da própria execução do `execute()`, em modo essencialmente autocommit, em vez de durar até o commit da transação MikroORM.

Na prática, isso permitia que dois publicadores concorrentes obtivessem exatamente o mesmo lote de mensagens pendentes, quebrando a garantia central da seção 11 do desafio (nenhuma mensagem entregue a dois publicadores ao mesmo tempo).

Corrigido substituindo o SQL bruto pela API nativa do MikroORM: `em.find()` com `lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE`, que mapeia diretamente para `FOR UPDATE SKIP LOCKED` no driver Postgres e já está corretamente vinculada ao contexto de transação ativo do `EntityManager` — eliminando a necessidade de SQL bruto e de gerenciar manualmente o contexto de transação.

### Teste de concorrência do outbox instável (flaky) por depender de timing de rede

Mesmo após a correção anterior, o teste de publicadores concorrentes da outbox falhava intermitentemente ao rodar contra o Neon (Postgres serverless hospedado), porque as duas transações do teste — apesar de lançadas através de `Promise.all` — não necessariamente se sobrepõem no tempo. Dada a latência de rede real (~50-60ms por round-trip), uma transação podia completar inteiramente (`begin` → `select for update` → `commit`) antes da segunda sequer começar, fazendo com que a segunda transação simplesmente encontrasse as linhas já livres e pegasse o mesmo lote — sem que isso indicasse qualquer falha em `SKIP LOCKED`.

Corrigido substituindo a dependência implícita de timing por uma barreira de sincronização explícita: a segunda transação só tenta seu próprio `SELECT FOR UPDATE SKIP LOCKED` depois que a primeira sinaliza (via uma `Promise` resolvida no momento exato em que retorna do `lockDueBatchForUpdate`, e portanto já com os locks adquiridos) que já garantiu seus locks no banco; a primeira transação mantém-se aberta por um período fixo depois disso, dando tempo suficiente para a segunda completar sua tentativa antes do commit. Essa abordagem elimina a corrida de timing e tornou o teste determinístico (validado com múltiplas execuções consecutivas, sempre passando).

### `Money` aceitava códigos de moeda inexistentes

A validação de moeda em `Money.from()` usava apenas uma regex de formato (`/^[A-Z]{3}$/`), que aceita qualquer combinação de 3 letras maiúsculas — incluindo códigos que não existem na norma ISO-4217, como `"REA"` (o código correto para o Real brasileiro é `"BRL"`). Isso quebrava silenciosamente a garantia de que toda instância de `Money` no sistema representa uma moeda real, sem gerar nenhum erro visível até uma etapa posterior do pipeline.

Corrigido substituindo a regex de formato por uma validação contra um conjunto real de códigos ISO-4217 alpha-3 (`ISO_4217_CURRENCIES`, um `Set` com os códigos reconhecidos), mantendo a mesma assinatura pública e o mesmo tipo de erro (`InvalidMoneyError`).

---

## 13. Validação dos testes

Os testes unitários, de integração e de concorrência foram executados durante a validação do projeto.

A validação utilizou PostgreSQL (hospedado no Neon) e LocalStack como infraestrutura real para os cenários que dependem de banco de dados, transações, locks e mensageria — nenhum desses cenários usa mocks de Postgres ou SQS.

Os principais cenários validados incluem:

* atomicidade da transação financeira;
* concorrência de duas apostas sobre a mesma wallet;
* processamento paralelo de wallets diferentes;
* concorrência de idempotência;
* referências fora de ordem;
* reversão dupla;
* concorrência entre publishers da outbox (com sincronização determinística, ver seção 12);
* integração com PostgreSQL;
* processamento através do SQS;
* comportamento de retry e mensagens não confirmadas;
* validação de dinheiro e código de moeda (ISO-4217).

Os testes de concorrência utilizam `EntityManager` forkado para garantir que as operações concorrentes utilizem conexões/transações independentes e disputem os locks reais do PostgreSQL.

A validação também confirmou que a lógica de negócio permanece compartilhada entre HTTP e SQS através do mesmo `SubmitWagerTransactionUseCase`.

**Resultado da última execução completa da suíte** (`bun run test:all`, contra Postgres real e LocalStack): **47 de 47 testes passando**, across 9 arquivos (unitários, integração e concorrência), 108 `expect()` calls, 0 falhas.

---

## 14. Limitações conhecidas e o que faria com mais tempo

### Teste de carga

Um teste de carga dedicado utilizando k6 não foi implementado.

O script `test:load` não está presente no `package.json` e o runner k6 não foi incluído, pois a prioridade foi atender os requisitos obrigatórios do desafio relacionados a correção financeira, concorrência, idempotência, mensageria e recuperação.

### Ledger de partidas dobradas

Foi implementado o ledger simples, conforme requisito obrigatório.

A versão de partidas dobradas foi deixada como melhoria futura, pois aparece como diferencial opcional no desafio.

### Worker morto entre commit e ACK

O desenho cobre conceitualmente o cenário em que o worker termina após o commit da operação e antes do `DeleteMessage`.

Como o ACK não é realizado antes da conclusão da operação, a mensagem volta a ficar disponível após o `VisibilityTimeout` e pode ser reprocessada.

A idempotência impede uma segunda aplicação financeira.

Embora o comportamento seja coberto pelo desenho e pelo fluxo de reentrega do SQS, um teste que mate literalmente o processo com `kill -9` entre essas duas etapas não foi priorizado.

### Três ou mais instâncias simultâneas

Os testes de concorrência foram executados utilizando múltiplos `EntityManager` forkados e conexões independentes contra o PostgreSQL real.

Isso permite validar a competição pelo lock no banco.

A execução com três ou mais containers independentes utilizando:

```text
docker compose up --scale
```

não foi utilizada como estratégia principal de teste, embora a arquitetura suporte múltiplas instâncias.

### Autenticação

A autenticação permanece deliberadamente não implementada, conforme a decisão documentada na seção 1.

Em produção, seria adicionada autenticação JWT através de um IdP como Keycloak, mantendo a identidade do provider separada dos dados enviados no corpo da requisição.