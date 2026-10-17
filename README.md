# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) com
**correção monetária, idempotência persistente e concorrência segura entre instâncias**.
Desafio técnico da Jungle Gaming.

Stack: Bun, TypeScript (strict), NestJS, PostgreSQL 16, MikroORM (migrations), Docker Compose.

> Decisões, trade-offs e limitações detalhados em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Status honesto

| Área | Situação |
|---|---|
| Money (string decimal, 2 casas, imutável, multi-moeda) | Feito, com testes |
| Wallet, WagerTransaction, WalletLedgerEntry (domínio puro) | Feito, com testes |
| Schema com constraints, índices parciais e ledger append-only (trigger) | Feito, migrations reversíveis |
| POST /wallets (com OPENING) | Feito |
| POST /wagering/transactions (BET, WIN, LOSS, REFUND, ROLLBACK) | Feito |
| Idempotência persistente (key + payloadHash) | Feito |
| Concorrência (lock por wallet), testes com Postgres real | Feito |
| PENDING_REFERENCE + worker com backoff exponencial | Feito |
| Consultas (wallet, ledger paginado por cursor, transações) | Feito |
| Reconciliação | Feito |
| Transactional Outbox + publisher com SKIP LOCKED | Feito |
| Health live e ready (Postgres e SQS) | Feito |
| Consumidor SQS + inbox + DLQ (erros permanentes) | Feito, testado com LocalStack real |
| Publicação da outbox em SQS (wager-events.fifo) | Feito (`EVENT_PUBLISHER=log` volta ao publisher de log) |
| **Métricas e logs JSON estruturados completos** | **Parcial** (logs simples, sem métricas) |
| Classes InboxMessage / OutboxMessage / IntegrationEvent | Não implementado (eventos montados como objetos) |
| Teste com 3 ou mais instâncias, teste de carga | Não implementado |
| Autenticação | Não implementada (AuthGuard no-op como ponto de extensão) |

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

## Como rodar

```bash
bun install
docker compose up -d          # Postgres e LocalStack
bun run migration:up          # cria o schema
bun run start:dev             # API em http://localhost:3000
```

O LocalStack está fixado na versão 3.8 porque as versões novas exigem token de licença. Ele ainda
não é usado pela aplicação (SQS não implementado).

### Migrations

As migrations usam a CLI do MikroORM e **precisam rodar com `bunx --bun`** (já embutido nos scripts):

```bash
bun run migration:up
bun run migration:down        # desfaz a última migration
```

### Testes

Os testes de integração usam **Postgres real** (Docker). Pare o servidor antes, ou suba-o com
`OUTBOX_DISABLED=true`, para o publisher da aplicação não consumir eventos dos testes.

```bash
docker compose up -d
bun run migration:up
bun run test
```

O script roda cada arquivo separadamente para evitar disputa de conexões:

- `src/domain`: 70 testes unitários (Money, Wallet, WagerTransaction, ledger, hash).
- `outbox.test.ts`: dois publishers concorrentes, retry com backoff, rollback sem perder evento.
- `wagering.concurrency.test.ts`: duas apostas de 80 com saldo 100, 50 requisições idênticas em
  paralelo, conflito de payload, wallets distintas em paralelo, WIN/LOSS.
- `reversal.test.ts`: REFUND/ROLLBACK, dupla reversão, 20 REFUNDs concorrentes, saldo negativo,
  PENDING_REFERENCE e REFERENCE_NOT_FOUND.

Todos terminam verificando a invariante: **saldo da wallet == soma do ledger**.

## API

Os exemplos usam `curl`. No PowerShell, grave o JSON num arquivo e use `--data-binary "@arquivo.json"`.

### Criar wallet
POST /wallets
{ "playerId": "<uuid>", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }


`201` com `id`, `balance`, `version`. Duplicada (mesmo player e moeda): `409`.

### Submeter transação

POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
{
"providerId": "provider-a",
"externalTransactionId": "transaction-123",
"playerId": "<uuid>", "walletId": "<uuid>",
"roundId": "round-987", "gameId": "fortune-chimp",
"kind": "BET",
"money": { "amount": "25.00", "currency": "BRL" }
}


REFUND e ROLLBACK exigem também `"referenceExternalTransactionId"`.

Resposta: `{ transactionId, status, balance, idempotentReplay, failureCode? }`.

| Situação | HTTP |
|---|---|
| Processada | 200 |
| Aguardando referência (PENDING_REFERENCE) | 202 |
| Payload inválido / header ausente | 400 |
| Wallet inexistente | 404 |
| Mesma key com payload diferente | 409 |
| Rejeitada por regra de negócio (corpo traz `failureCode`) | 422 |
| Falha transitória (pode reenviar com a mesma key) | 503 |

### Consultas

GET /wallets/:walletId
GET /wallets/:walletId/ledger?cursor=...&limit=50
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wallets/:walletId/reconciliation
GET /health/live
GET /health/ready


### Variáveis de ambiente (opcionais)

`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_MAX`, `PORT`,
`OUTBOX_DISABLED`, `OUTBOX_INTERVAL_MS`, `REFERENCE_MAX_ATTEMPTS`.

## Estrutura

src/
domain/ Regras puras (sem NestJS, sem banco): Money, Wallet, WagerTransaction, ledger, hash
application/ Casos de uso, outbox, worker de referência, consultas
api/ Controllers HTTP
infrastructure/ Pool pg, helper de transação, publisher de eventos
migrations/ Migrations MikroORM (up e down)
auth/ AuthGuard no-op


