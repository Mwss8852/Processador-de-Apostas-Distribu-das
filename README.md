# ARCHITECTURE.md — Resumo

Serviço de apostas (NestJS/Bun, PostgreSQL/Neon, MikroORM, SQS/LocalStack) focado em correção financeira, concorrência e idempotência.

---

## 1. Autenticação

### Não implementada de propósito

Não vale pontos no desafio. Em produção seria JWT com Keycloak e um `ProviderIdentityPort`.

## 2. Modelagem de dinheiro

### `Money` imutável sobre `Decimal.js`

Nunca `number`. Rejeita NaN, notação científica, mais de 2 casas e negativos na entrada. Coluna `numeric(18,2)`. Moeda validada contra ISO-4217.

## 3. ORM e estratégia transacional

### MikroORM com domínio separado

Entidades de persistência separadas do domínio via mappers. Nenhuma classe de domínio importa `@mikro-orm/core`.

## 4. Fronteira transacional

### `WageringUnitOfWork` sobre `em.transactional()`

Wager, saldo, ledger, inbox e outbox confirmam juntos ou nenhum é persistido.

## 5. Concorrência

### Lock pessimista por linha da wallet

`FOR UPDATE` via `LockMode.PESSIMISTIC_WRITE`, sem lock global, em `READ COMMITTED`. Lock otimista foi descartado por causa de retries em hot wallet.

## 6. Idempotência

### Dois níveis de deduplicação

Inbox `(consumerName, messageId)` e `Idempotency-Key` com índice único. `payloadHash` SHA-256. Mesma chave com payload diferente retorna 409.

## 7. Mapeamento HTTP e taxonomia de falhas

### `RETRY_SAFE`, `FIX_AND_RETRY`, `DO_NOT_RETRY`

Status 201 (processada), 202 (pendente de referência) e 200 (replay ou rejeição de negócio).

## 8. Referências fora de ordem

### `PENDING_REFERENCE` com worker e backoff

Backoff exponencial (base 2s, máximo 5min, jitter). Após 8 tentativas, rejeita com `REFERENCE_NOT_FOUND_TIMEOUT`.

## 9. Outbox transacional e publicação

### `FOR UPDATE SKIP LOCKED`

Via `LockMode.PESSIMISTIC_PARTIAL_WRITE`. Publica só depois do commit. Duplicação possível, tratada pela idempotência.

## 10. Consumer SQS

### Mesmo caso de uso do HTTP

`DeleteMessage` só em resultado terminal. DLQ com `maxReceiveCount = 5`. Graceful shutdown com `Promise.allSettled`.

## 11. Observabilidade

### Logs, métricas e health

Logs `pino` sem valores financeiros, métricas Prometheus em `/metrics`, health `live` e `ready`.

## 12. Bugs encontrados e corrigidos

### Corrida de idempotência

`UniqueConstraintViolationException` vazava. Agora relê a transação vencedora e trata como replay se o hash for igual.

### Backoff antes da primeira tentativa

A primeira tentativa agora é imediatamente elegível.

### Pool de conexões

Configurado explicitamente (`min: 2`, `max: 10`; `min: 0` no Neon).

### Problema de infraestrutura no Docker

Faltava `.dockerignore`; `dist/` e `node_modules/` entravam na imagem. `TRUNCATE ... CASCADE` foi trocado por `DELETE`.

### Trigger de imutabilidade do ledger bloqueava a limpeza de testes

Retornar `NULL` no `BEFORE DELETE` cancela a operação em silêncio. Corrigido retornando `OLD`/`NEW` quando `app.allow_ledger_cleanup` está ativa.

### `truncateAll` não executava como uma transação única

A primeira versão do helper de limpeza (`test/integration/setup.ts`) usava `conn.execute('BEGIN')`, os `DELETE`s e `conn.execute('COMMIT')` via `orm.em.getConnection()`. Como a conexão é apoiada por um pool, cada chamada podia cair em uma conexão física diferente, sem garantia de mesma sessão.

Consequências:

* `set_config('app.allow_ledger_cleanup', 'true', true)` é local à transação; se o `DELETE FROM wallet_ledger_entries` caía em outra conexão, o trigger `forbid_ledger_mutation()` não liberava a limpeza, e o `DELETE FROM wager_transactions` falhava na FK `wallet_ledger_entries_transaction_id_fkey`.
* Um `BEGIN` sem `COMMIT` na mesma conexão podia deixar uma sessão "idle in transaction" segurando locks, o que provavelmente causou os timeouts de 15s nos testes seguintes.

Corrigido com uma transação real do MikroORM, em que tudo roda na mesma conexão:

```ts
await orm.em.fork().transactional(async (em) => {
  await em.execute(`SELECT set_config('app.allow_ledger_cleanup', 'true', true)`);
  await em.execute('DELETE FROM wallet_ledger_entries');
  await em.execute('DELETE FROM wager_transactions');
  await em.execute('DELETE FROM wallets');
  await em.execute('DELETE FROM inbox_messages');
  await em.execute('DELETE FROM outbox_messages');
});
```

Após a correção, a suíte de integração passou de 131s (4 falhas) para cerca de 16s, com todos os testes passando.

### `FOR UPDATE SKIP LOCKED` não participava da transação real

SQL bruto via `em.getConnection().execute()` rodava fora da transação. Corrigido com `em.find()` e `LockMode.PESSIMISTIC_PARTIAL_WRITE`.

### Teste de concorrência do outbox instável (flaky)

Dependia do timing de rede. Corrigido com uma barreira de sincronização explícita entre as duas transações.

### `Money` aceitava códigos de moeda inexistentes

A regex `/^[A-Z]{3}$/` aceitava códigos como `"REA"`. Trocada por um `Set` de códigos ISO-4217.

## 13. Validação dos testes

### 47 de 47 passando

35 unitários, 7 de integração e 5 de concorrência, contra Postgres real e LocalStack, sem mocks.

A limpeza entre testes (`truncateAll`) roda em uma única transação real (`em.transactional`), garantindo que a flag do trigger do ledger e os `DELETE`s compartilhem a mesma conexão.

## 14. Limitações conhecidas

### O que ficou de fora

* Teste de carga com k6.
* Ledger de partidas dobradas.
* Teste com `kill -9` entre commit e ACK.
* Teste com 3 ou mais containers (`docker compose up --scale`).
* Autenticação (ver seção 1).

---

> Lembrete: a frase "validado com múltiplas execuções consecutivas" na entrada do outbox flaky só deve ficar se você realmente rodou a suíte várias vezes.
>
> ### Resolve problemas migrações do Codespace
>
> BRIDGE=$(docker network inspect processador-de-apostas-distribu-das_default --format '{{.Id}}' | cut -c1-12)

sudo iptables-legacy -I FORWARD -i br-$BRIDGE -o br-$BRIDGE -j ACCEPT

sudo iptables-legacy -I FORWARD -i br-$BRIDGE ! -o br-$BRIDGE -j ACCEPT

sudo iptables-legacy -I FORWARD -o br-$BRIDGE -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

echo "Regras aplicadas para bridge br-$BRIDGE"
