# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) com
**precisão monetária, idempotência persistente e concorrência segura entre instâncias**.
Desafio técnico da Jungle Gaming.

Stack: Bun, TypeScript (strict), NestJS, PostgreSQL 16, AWS SQS (LocalStack 3.8), MikroORM (migrations), Docker Compose.

Decisões, trade-offs e limitações em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Status

| Área | Situação |
|---|---|
| Money (string decimal, 2 casas, imutável, multi-moeda) | Feito, testado |
| Domínio: Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, OutboxMessage, IntegrationEvent | Feito, testado |
| Schema com constraints, índices parciais e ledger append-only (trigger) | Feito, migrations reversíveis |
| POST /wallets (com transação OPENING, ledger e outbox) | Feito |
| POST /wagering/transactions: BET, WIN, LOSS, REFUND, ROLLBACK | Feito |
| Idempotência persistente (key + payloadHash) | Feito |
| Concorrência por wallet (SELECT FOR UPDATE), Postgres real | Feito |
| PENDING_REFERENCE + worker com backoff exponencial | Feito |
| Consultas (wallet, ledger com cursor opaco, transações) e reconciliação | Feito |
| Transactional Outbox, publisher com SKIP LOCKED, publicação em SQS | Feito |
| Consumidor SQS: inbox na mesma transação, ack após commit, retry, DLQ, SIGTERM | Feito, testado em LocalStack |
| Testes: crash entre commit e ack, retry transitório até a DLQ | Feito |
| Teste com 3 processos reais e teste de carga | Feito |
| Health live e ready (Postgres e SQS) | Feito |
| Logs JSON e métricas Prometheus (/metrics) | Feito, com lacunas (ver ARCHITECTURE) |
| Autenticação | Não implementada (AuthGuard no-op como ponto de extensão) |

## Pré-requisitos

- [Bun](https://bun.sh) 1.x e Node.js (as instâncias dos testes multi-processo rodam o build com Node)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

## Como rodar

```bash
bun install
docker compose up -d          # Postgres 16 e LocalStack 3.8 (SQS)
bun run migration:up          # cria o schema
bun run start:dev             # API em http://localhost:3000
```

Ao subir, a aplicação cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 recebimentos)
e `wager-events.fifo`. LocalStack está fixado na 3.8 porque as versões novas exigem token de licença.

As migrations usam a CLI do MikroORM e **precisam de `bunx --bun`** (já embutido nos scripts):

```bash
bun run migration:up
bun run migration:down        # desfaz a última migration
```

### Variáveis de ambiente (opcionais)

| Variável | Efeito |
|---|---|
| `PORT`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_MAX` | Servidor e banco |
| `SQS_ENDPOINT`, `AWS_REGION`, `SQS_MAX_RECEIVE` | SQS (padrão: LocalStack, us-east-1, 5) |
| `EVENT_PUBLISHER=log` | Publica eventos da outbox em log em vez de SQS |
| `OUTBOX_DISABLED=true` | Desliga o scheduler (outbox e worker de referência) |
| `SQS_CONSUMER_DISABLED=true` | Desliga o consumidor SQS |
| `OUTBOX_INTERVAL_MS`, `REFERENCE_MAX_ATTEMPTS` | Intervalo do scheduler e limite de tentativas de referência (padrão 8) |

## Testes

Todos os testes de integração usam **Postgres e LocalStack reais** (Docker). **Pare o servidor antes**: o scheduler e o consumidor
da aplicação competiriam com os testes pelas linhas da outbox e pela fila.

```bash
docker compose up -d
bun run migration:up
bun run test          # domínio + integração, um arquivo por vez
bun run test:multi    # build + 3 processos Node reais no mesmo Postgres
bun run test:load     # build + teste de carga com 3 instâncias (gera load-report.json)
```

| Arquivo | O que prova |
|---|---|
| `src/domain/*` (76 testes) | Money, Wallet, WagerTransaction, ledger, hash, eventos, outbox/inbox |
| `outbox.test.ts` | Dois publishers concorrentes sem duplicar, retry com backoff, rollback sem perder evento |
| `wagering.concurrency.test.ts` | Duas apostas de 80 com saldo 100; 50 requisições idênticas em paralelo; conflito de payload; wallets distintas; WIN/LOSS |
| `reversal.test.ts` | REFUND/ROLLBACK, dupla reversão, 20 REFUNDs concorrentes, saldo negativo, PENDING_REFERENCE, REFERENCE_NOT_FOUND |
| `queue-consumer.test.ts` | Mensagem entregue duas vezes gera um débito; mensagem malformada vai para a DLQ |
| `crash-recovery.test.ts` | Commit feito e ack perdido: o redelivery é barrado pela inbox |
| `retry-dlq.test.ts` | Falha transitória repetida chega à DLQ via redrive do SQS (fila de teste com maxReceiveCount 2) |
| `multi-instance.test.ts` | 3 processos reais: 30 apostas disputando saldo 100, 60 envios da mesma aposta |

Os testes de dinheiro terminam verificando a invariante: **saldo da wallet == soma do ledger**.

## Teste de carga

`bun run test:load` sobe 3 instâncias (Node, build em `dist/`) contra 1 Postgres em Docker na mesma máquina.
Fase A: 4000 BETs de 1.00 em 200 wallets, 10% de reenvios, concorrência 64. Fase B: 400 BETs em uma única wallet com saldo 100.

Resultado de uma execução (Node 26, Windows, 8 CPUs; uma execução, sem aquecimento, clientes e Postgres disputando a mesma máquina):

| Fase | Throughput | p50 | p95 | p99 | Erros 5xx |
|---|---|---|---|---|---|
| A: carga espalhada | 379 req/s | 139 ms | 308 ms | 562 ms | 0 |
| B: wallet quente | 69 req/s | 797 ms | 1537 ms | 2497 ms | 0 |

- Fase A: 4000 respostas 200, sendo 386 replays e 3614 processadas.
- Fase B: exatamente 100 processadas e 300 rejeitadas com 422; saldo final 0.00.
- Verificações finais, todas verdadeiras: saldo == ledger em todas as wallets, total debitado == BETs processadas, sem 5xx.
- Outbox: pico de 4979 eventos pendentes drenado em ~25 s (publisher de log).

Leitura: a wallet quente é ~5x mais lenta porque o lock pessimista serializa as operações da mesma wallet (custo assumido).
A latência da fase A é alta para uma operação simples, mas **não foi investigado** se o gargalo é fila de conexões, CPU compartilhada
ou lock; são hipóteses. Os números são de um laptop e não representam produção. O relatório completo está em `load-report.json`.

## API

No PowerShell, grave o JSON num arquivo e use `curl.exe --data-binary "@arquivo.json"`.
POST /wallets
{ "playerId": "<uuid>", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }


`201` com `id`, `balance`, `version`. Wallet duplicada (mesmo player e moeda): `409`.

POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
{
"providerId": "provider-a", "externalTransactionId": "transaction-123",
"playerId": "<uuid>", "walletId": "<uuid>",
"roundId": "round-987", "gameId": "fortune-chimp",
"kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
}


REFUND e ROLLBACK exigem também `"referenceExternalTransactionId"`.
Resposta: `{ transactionId, status, balance, idempotentReplay, failureCode? }`.

| Situação | HTTP |
|---|---|
| Processada (inclusive replay) | 200 |
| Aguardando referência (PENDING_REFERENCE) | 202 |
| Payload inválido, header ausente, cursor inválido | 400 |
| Wallet inexistente | 404 |
| Mesma key com payload diferente | 409 |
| Rejeitada por regra de negócio (corpo traz `failureCode`) | 422 |
| Falha transitória (reenviar com a mesma key) | 503 |

Consultas e operação:

GET /wallets/:walletId
GET /wallets/:walletId/ledger?cursor=...&limit=50
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wallets/:walletId/reconciliation
GET /health/live
GET /health/ready (Postgres e SQS)
GET /metrics (formato Prometheus, por instância)


## Estrutura

src/
domain/ Regras puras (sem NestJS nem banco)
application/ Casos de uso, outbox, worker de referência, consultas
api/ Controllers HTTP
infrastructure/ Pool pg, transação, SQS (consumidor e publisher), métricas, logs JSON
migrations/ Migrations MikroORM (up e down)
auth/ AuthGuard no-op
scripts/ load-test.ts

