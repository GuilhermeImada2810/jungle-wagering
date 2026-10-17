# ARCHITECTURE

Decisões técnicas, motivos e limitações conhecidas.

## 1. Visão geral

Domínio puro (`src/domain`), casos de uso que orquestram **uma transação SQL** (`src/application`), controllers finos (`src/api`)
e adaptadores (`src/infrastructure`). O banco é a última linha de defesa: unicidade, imutabilidade e não-negatividade estão no schema.

Fluxo de `POST /wagering/transactions` (um único BEGIN/COMMIT):

1. `SELECT ... FOR UPDATE` na wallet.
2. Verificação de idempotência (key + hash).
3. Regra de negócio no domínio (`Wallet.debit/credit`, `WagerTransaction`, `resolveReversal`).
4. INSERT da transação, INSERT do lançamento, UPDATE do saldo e da `version`.
5. INSERT dos eventos na outbox.
6. COMMIT. Só depois um publisher envia os eventos.

O consumidor SQS reutiliza **o mesmo caso de uso**, passando o client da sua transação, de modo que inbox, saldo, ledger e outbox
ficam no mesmo COMMIT.

## 2. Stack e justificativas

- Bun, TypeScript strict, NestJS, PostgreSQL 16, Docker Compose: exigidos.
- **LocalStack 3.8**: versões novas exigem token de licença. As URLs das filas são montadas à mão (`endpoint/000000000000/<nome>`).
- **ORM**: MikroORM só para **migrations e mapeamento** (`EntitySchema`, sem decorators). O **caminho crítico de escrita usa SQL
  explícito via `pg`** (BEGIN, FOR UPDATE, ON CONFLICT, COMMIT). Motivo: lock, ordem das operações e transação ficam visíveis e
  auditáveis, e a API de SQL cru do MikroORM 7 gerou incerteza. Trade-off: abre mão do Unit of Work/Identity Map preferidos pelo enunciado.
- **Migrations** reversíveis, validadas com up, down, up. Rodam com `bunx --bun` (com Node/jiti a CLI falha com `MigrationClass is not a constructor`).
- Testes de múltiplos processos rodam o build (`dist/`) com **Node**, porque o runtime do Bun não emite metadados de decorators usados na injeção de dependência do Nest.

## 3. Money

- String decimal com 2 casas e `decimal.js`. Nunca `number`.
- Regex `^\d+(\.\d{1,2})?$` **antes** do Decimal (que aceitaria `NaN`, `Infinity`, `1e5`).
- `"10"` e `"10.5"` normalizam para `10.00` e `10.50`; mais de 2 casas é rejeitado (nunca se arredonda dinheiro em silêncio).
  Negativos só existem como resultado de `subtract`.
- Moedas diferentes: `CurrencyMismatchError`.
- Persistência: `numeric(18,2)` + `char(3)`, lido como string, nunca `number`.

## 4. Schema: regra -> garantia no banco

| Regra | Garantia |
|---|---|
| Uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Moeda ISO | `CHECK (currency ~ '^[A-Z]{3}$')` |
| Transação do provedor única | `UNIQUE (provider_id, external_transaction_id)` |
| Idempotency key única por provedor | `UNIQUE (provider_id, idempotency_key)` |
| Kind/status válidos, valor >= 0 | `CHECK ... IN (...)`, `CHECK (amount >= 0)` |
| REFUND/ROLLBACK exigem referência; os demais não têm | `wt_reference_ck` |
| REJECTED/FAILED têm failure_code; PROCESSED tem processed_at | `wt_failure_ck`, `wt_processed_ck` |
| Mesma referência não revertida duas vezes pelo mesmo tipo | índice único parcial `(reference_transaction_id, kind) WHERE status='PROCESSED'` |
| Um lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` |
| Aritmética do lançamento | `CHECK` (antes ± valor = depois) |
| **Ledger imutável** | triggers `BEFORE UPDATE/DELETE` e `BEFORE TRUNCATE` que lançam exceção |
| Inbox sem duplicata | `PRIMARY KEY (consumer_name, message_id)` |
| Outbox: payload é objeto JSON; achar pendentes rápido | `CHECK`, índice parcial `WHERE published_at IS NULL` |
| Fila de PENDING_REFERENCE | índice parcial por `reference_next_attempt_at` |

Testadas manualmente no `psql` e por testes automatizados.

## 5. Concorrência

- **Pessimista por wallet**: `SELECT ... FOR UPDATE`. A unidade é a `walletId`; wallets diferentes não se bloqueiam; não há lock global.
- Sem o lock, duas apostas leriam o mesmo saldo. Com ele, a segunda espera, lê o saldo atualizado e é rejeitada.
- **Ordem de locks**: a wallet é travada **antes** de qualquer INSERT. Inserir a transação antes seguraria um lock compartilhado na wallet via FK, e
  dois workers poderiam entrar em deadlock. O worker de referência usa a mesma ordem (wallet, depois transação).
- `version` incrementa só quando o saldo muda; `UPDATE ... WHERE version = $n` é checagem adicional.
- **Trade-off**: uma wallet muito disputada serializa. No teste de carga, 400 apostas numa wallet deram 69 req/s contra 379 req/s espalhadas.
- Correção sob várias instâncias: o estado inteiro está no Postgres (locks de linha, UNIQUE, SKIP LOCKED). Provado com 3 processos Node reais
  (`multi-instance.test.ts`) e no teste de carga.

## 6. Idempotência

- Persistente no banco; nunca em memória.
- `Idempotency-Key` é obrigatória e é a fonte da verdade.
- `payloadHash` = SHA-256 (hex) do JSON canônico (chaves ordenadas, sem espaços, sem `undefined`) de: `providerId`, `externalTransactionId`,
  `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (normalizado) e `referenceExternalTransactionId` (só em reversões). Header e
  metadados de transporte ficam fora.
- Mesma key e mesmo hash: replay (`idempotentReplay: true`, mesmo `transactionId`, mesmo status e o saldo da época, guardado em `balance_after`).
- Mesma key (ou mesmo `externalTransactionId`) com hash diferente: 409.
- 50 requisições simultâneas: disputam o lock; a primeira grava; as demais encontram a transação e devolvem replay. `INSERT ... ON CONFLICT DO NOTHING`
  é rede de segurança do banco, com uma nova tentativa.

## 7. Máquina de estados da WagerTransaction
PENDING --> PROCESSED | REJECTED | FAILED
PENDING --> PENDING_REFERENCE --> PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED: terminais (transicionar lança InvalidTransactionStateError)


`OPENING` é interno: só nasce com `internal: true`, nunca pela API nem pela fila.

## 8. Taxonomia de failureCode

| Código | Quando | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | Usar outro id para tentar de novo |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão deixaria saldo negativo | Situação operacional distinta; tratar manualmente |
| `REFERENCE_NOT_FOUND` | Referência não chegou no limite de tentativas | Verificar o id referenciado |
| `REFERENCE_MISMATCH` | Provider, player, wallet, moeda ou rodada diferentes | Corrigir o payload |
| `INVALID_REFERENCE_KIND` | Ex.: REFUND de um WIN | Corrigir o payload |
| `REFERENCE_NOT_APPLIED` | Referência foi rejeitada ou falhou | Nada a reverter |
| `ALREADY_REVERSED` | Referência já revertida (por REFUND ou ROLLBACK) | Desistir |
| `AMOUNT_MISMATCH` | Valor diferente da referência | Corrigir o valor (parcial fora de escopo) |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet | Corrigir o payload |
| `WALLET_NOT_FOUND`, `INTERNAL_ERROR` | Reservados, não emitidos hoje | |

## 9. Mapeamento HTTP

201 criado | 200 processado/replay | 202 aguardando referência | 400 inválido | 404 não encontrado | 409 conflito |
422 rejeição de negócio (com `failureCode`) | 503 falha transitória. O provedor decide reenviar só pelo status: 503 reenvia a mesma key; 400/409/422 não.

## 10. REFUND e ROLLBACK

- Referência resolvida por `(providerId, referenceExternalTransactionId)` e validada: provider, player, wallet, moeda, rodada e valor.
- REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND. A direção do ROLLBACK é a inversa da referência.
- **Interpretação**: REFUND e ROLLBACK da mesma transação se bloqueiam (`ALREADY_REVERSED`); senão o dinheiro voltaria duas vezes. O índice
  parcial só impede o mesmo tipo duas vezes; o caso cruzado é tratado sob o lock da wallet.
- Referência ausente: `PENDING_REFERENCE` (202) e evento. O worker reprocessa com backoff exponencial (5s * 2^tentativas, teto 10 min),
  limite padrão de 8 tentativas; esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` e evento.
  Justificativa: cobre atrasos normais de entrega sem manter pendência indefinida.
- Referência que também está PENDING_REFERENCE: espera.
- **WIN com referência**: o enunciado diz que pode referenciar a BET, mas o schema só permite referência em REFUND/ROLLBACK. Interpretação: a referência de BET/WIN/LOSS é ignorada.

## 11. Outbox transacional e publicação

- Eventos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda) e
  `WagerTransactionPendingReference` são gravados na **mesma transação** do saldo e do ledger. Nada é publicado antes do commit.
- Classes: `IntegrationEvent` (abstrata, com subclasse por evento; `eventType` e `version` no tipo), `OutboxMessage`, `InboxMessage`.
  `data` carrega `MoneyProps`, nunca `Money`.
- Publisher (`OutboxDispatcher`): lote com `FOR UPDATE SKIP LOCKED`; publica; marca `published_at`; COMMIT. Falha: `attempts + 1` e `next_attempt_at` com backoff.
- Publicação real em `wager-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`). `EVENT_PUBLISHER=log` usa log.
- Garantia: **at-least-once**. Se o processo morre antes do COMMIT, o lock cai e outra instância publica (pode duplicar, nunca perde). Consumidores deduplicam por `eventId`.

## 12. Consumo SQS

- Inbox `(consumer_name, message_id)` inserida na **mesma transação** do efeito financeiro; `ON CONFLICT DO NOTHING` => `duplicate`.
- **Ack (DeleteMessage) só após o commit.**
- Classificação: erro de negócio terminal (payload inválido, conflito de idempotência): registra na inbox e dá ack. Rejeição de regra (saldo etc.) não é erro: vira
  transação `REJECTED` persistida e ack. Mensagem malformada ou wallet inexistente: **permanente**, copiada para a DLQ e ack. Falha transitória: sem ack, visibilidade
  com backoff (4s, 8s, ... teto 300s); após `maxReceiveCount` (5) o redrive do SQS move para a DLQ.
- SIGTERM: `enableShutdownHooks`; o consumidor termina a mensagem em andamento, devolve as demais (visibilidade 0) e encerra o loop; o pool fecha depois.
- FIFO (`MessageGroupId = walletId`) é otimização; o banco continua dono das invariantes.
- Testado em LocalStack real: redelivery duplicado, mensagem malformada para a DLQ, crash entre commit e ack, retry transitório até a DLQ.

## 13. Observabilidade

- `/health/live` e `/health/ready` (checa Postgres e SQS) separados.
- `/metrics` em formato Prometheus: `wager_transactions_total{status,kind}`, `wager_duplicates_total`, `wager_idempotency_conflicts_total`,
  histograma `wager_processing_seconds`, `wager_retries_total`, `wager_dlq_messages_total`, `wager_outbox_publish_failures_total`, gauge `wager_outbox_lag_seconds`.
  Replays contam em `wager_duplicates_total` (não em `wager_transactions_total`).
- Logs JSON: resultado de cada transação (`correlationId`, `transactionId`, `walletId`, `providerId`, `status`, `failureCode`) e eventos do consumidor, sem payload financeiro.
- **Lacunas**: métricas ficam em memória, por instância, e zeram no restart (o coletor soma; nunca usadas para idempotência). **Não há contador de conflitos de lock.**
  Nem todo ponto do fluxo emite log JSON (parte usa o logger do Nest, com mensagem em JSON). Sem OpenTelemetry nem dashboard.

## 14. Autenticação

Não implementada (seção 2 do desafio: não vale pontos). Desenho: IdP externo (Keycloak/OIDC), JWT validado em `AuthGuard` global, `/health/*` aberto.
Ponto de extensão: `src/auth/auth.guard.ts` (no-op) registrado como `APP_GUARD`.

## 15. Teste de carga

Ver README. Resumo: 3 instâncias, fase espalhada 379 req/s (p99 562 ms) e fase de wallet quente 69 req/s (p99 2497 ms), 0 erros 5xx, saldo == ledger em todas as wallets.
Uma execução num laptop, clientes e Postgres na mesma máquina. **O gargalo da latência não foi diagnosticado.**

## 16. Limitações conhecidas

1. O publisher chama o broker **dentro** da transação (com locks da outbox). É simples e correto para at-least-once, mas um broker lento segura a transação. Alternativa: lease e publicar fora.
2. `OutboxDispatcher` e o consumidor ainda usam SQL direto na leitura; `OutboxMessage` e `InboxMessage` são usados na escrita da outbox e estão testados, mas não reidratados no publisher/consumidor.
3. O publisher SQS não tem teste automatizado contra SQS real (o publisher é testado com dublê; o consumidor, com LocalStack).
4. O teste de DLQ por retry usa fila de teste com `maxReceiveCount = 2`; o padrão da aplicação é 5. Redrive validado no LocalStack 3.8; em AWS real não foi testado.
5. Consumidor, scheduler da outbox e worker de referência rodam dentro de cada instância da API; em produção seriam processos separados.
6. Consumidor processa as mensagens de um lote sequencialmente.
7. Triggers do ledger podem ser removidos pelo dono do banco; em produção a aplicação usaria usuário sem esse privilégio.
8. IDs são UUID v4 (`randomUUID`), não v7.
9. Testes de integração exigem servidor parado e rodam arquivo a arquivo (conexões e fila compartilhadas).
10. Sem contador de conflitos de lock; sem tracing distribuído.
11. Reversão parcial fora de escopo, como no enunciado.
