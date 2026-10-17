# ARCHITECTURE

Este documento registra as decisões técnicas, os motivos e as limitações conhecidas.

## 1. Visão geral

Uma camada de domínio pura (`src/domain`) com as regras; casos de uso (`src/application`) que
orquestram **uma transação SQL**; controllers finos (`src/api`). O banco é a última linha de defesa:
unicidade, imutabilidade e não-negatividade estão no schema, não só no código.

Fluxo do `POST /wagering/transactions`, tudo em um único BEGIN/COMMIT:

1. `SELECT ... FOR UPDATE` na wallet.
2. Verifica idempotência (key + hash).
3. Aplica a regra no domínio (`Wallet.debit/credit`, `WagerTransaction`).
4. Insere a transação, o lançamento do ledger e atualiza o saldo e a `version`.
5. Insere os eventos na outbox.
6. COMMIT. Só depois o publisher envia os eventos.

## 2. Stack e justificativas

- **Bun / TypeScript strict / NestJS / PostgreSQL / Docker Compose**: exigidos.
- **LocalStack 3.8**: as versões novas exigem token de licença. Está no compose, mas a aplicação ainda não usa SQS.
- **ORM (decisão importante)**: MikroORM é usado para **migrations e mapeamento** (`EntitySchema`, sem decorators). O
  **caminho crítico de escrita usa SQL explícito via `pg`** (BEGIN, `SELECT ... FOR UPDATE`, `ON CONFLICT`, COMMIT).
  Motivo: o lock, a ordem das operações e a transação ficam visíveis e auditáveis, e a API do MikroORM 7
  gerou incerteza em SQL cru e decorators. Trade-off: foge da preferência do desafio por Unit of Work/Identity Map.
- **Migrations**: versionadas e reversíveis (`up` e `down`), validadas com up, down, up. Rodam com `bunx --bun`
  (com Node/jiti a CLI falha com `MigrationClass is not a constructor`).

## 3. Money

- Valor como **string decimal com 2 casas** (`"25.00"`) e `decimal.js`. Nunca `number`.
- Entrada validada por regex `^\d+(\.\d{1,2})?$` **antes** de chegar ao Decimal (o Decimal aceitaria `NaN`, `Infinity`, `1e5`).
- Decisão: `"10"` e `"10.5"` são aceitos e normalizados para `10.00` e `10.50`; **mais de 2 casas é rejeitado**
  (nunca se arredonda dinheiro em silêncio). Negativos são rejeitados na entrada; podem existir só como resultado de `subtract`.
- Moedas diferentes lançam `CurrencyMismatchError` (erro de domínio).
- Persistência: `numeric(18,2)` + coluna de moeda `char(3)`, reidratado como `Money`. Exato, sem ponto flutuante.

## 4. Schema: regra -> garantia no banco

| Regra | Garantia |
|---|---|
| Uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Moeda ISO | `CHECK (currency ~ '^[A-Z]{3}$')` |
| Transação do provedor única | `UNIQUE (provider_id, external_transaction_id)` |
| Idempotency key única por provedor | `UNIQUE (provider_id, idempotency_key)` |
| Kind/status válidos, valor >= 0 | `CHECK ... IN (...)`, `CHECK (amount >= 0)` |
| REFUND/ROLLBACK exigem referência, os demais não têm | `wt_reference_ck` |
| REJECTED/FAILED sempre têm failure_code | `wt_failure_ck` |
| PROCESSED sempre tem processed_at | `wt_processed_ck` |
| Mesma referência não revertida duas vezes pelo mesmo tipo | índice único parcial `(reference_transaction_id, kind) WHERE status='PROCESSED'` |
| Um lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` |
| Aritmética do lançamento | `CHECK` (antes ± valor = depois) |
| **Ledger imutável** | triggers `BEFORE UPDATE/DELETE` e `BEFORE TRUNCATE` que lançam exceção |
| Inbox sem duplicata | `PRIMARY KEY (consumer_name, message_id)` |
| Outbox: payload objeto JSON, achar pendentes rápido | `CHECK`, índice parcial `WHERE published_at IS NULL` |

Todas foram testadas manualmente no `psql` e por testes automatizados.

## 5. Concorrência

- **Pessimista por wallet**: `SELECT ... FOR UPDATE` na linha da wallet. A unidade de concorrência é a `walletId`;
  wallets diferentes não se bloqueiam, não há lock global.
- **Por que não "read, calculate, update" sem controle**: duas apostas leriam o mesmo saldo e ambas debitariam.
  Com o lock, a segunda espera, lê o saldo já atualizado e é rejeitada.
- **Ordem de locks**: a wallet é travada **antes** de qualquer INSERT. Inserir a transação primeiro seguraria um
  lock compartilhado na wallet pela FK, e dois workers poderiam entrar em deadlock. O worker de referência usa a mesma ordem.
- `version` incrementa só quando o saldo muda; o `UPDATE ... WHERE version = $n` é uma checagem adicional.
- **Trade-off**: uma wallet muito disputada (hot wallet) serializa as operações. Aceitável porque corretude vem antes de throughput.

Cenário obrigatório (saldo 100, duas apostas de 80): exatamente uma PROCESSED, outra REJECTED, saldo 20, um débito no
ledger. Coberto por teste com Postgres real.

## 6. Idempotência

- Persistente no banco (nunca em memória).
- `Idempotency-Key` é a fonte da verdade e é obrigatória.
- `payloadHash` = SHA-256 (hex) do **JSON canônico** (chaves ordenadas, sem espaços) dos campos de negócio:
  `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (normalizado) e
  `referenceExternalTransactionId`. O header e metadados de transporte ficam fora.
- Mesma key e mesmo hash: **replay** (`idempotentReplay: true`, mesmo `transactionId`, mesmo status e o saldo da época, guardado em `balance_after`).
- Mesma key (ou mesmo `externalTransactionId`) com hash diferente: **409**.
- Como 50 requisições simultâneas resolvem: todas disputam o lock da wallet; a primeira grava; as seguintes encontram a
  transação e devolvem replay. O `INSERT ... ON CONFLICT DO NOTHING` é uma rede de segurança do banco (com uma tentativa extra).

## 7. Máquina de estados da WagerTransaction
PENDING --> PROCESSED
PENDING --> REJECTED
PENDING --> FAILED
PENDING --> PENDING_REFERENCE --> PENDING_REFERENCE (nova tentativa)
--> PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED: terminais (transicionar é erro de programação: InvalidTransactionStateError)


`OPENING` é interno: só nasce com `internal: true`, nunca pela API.

## 8. Taxonomia de failureCode

| Código | Quando | O que o provedor deve fazer |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | Usar outro id se quiser tentar de novo |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão deixaria saldo negativo | Situação operacional diferente de aposta sem saldo; tratar manualmente |
| `REFERENCE_NOT_FOUND` | Referência não apareceu após o limite de tentativas | Verificar o id referenciado |
| `REFERENCE_MISMATCH` | Provider, player, wallet, moeda ou rodada diferentes | Corrigir o payload |
| `INVALID_REFERENCE_KIND` | Ex.: REFUND de um WIN | Corrigir o payload |
| `REFERENCE_NOT_APPLIED` | Referência foi rejeitada/falhou | Nada a reverter |
| `ALREADY_REVERSED` | Referência já revertida | Desistir (já foi revertida) |
| `AMOUNT_MISMATCH` | Valor da reversão diferente da referência | Corrigir o valor (parcial está fora de escopo) |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet | Corrigir o payload |
| `WALLET_NOT_FOUND`, `INTERNAL_ERROR` | Reservados | |

## 9. Mapeamento HTTP

| Situação | Status |
|---|---|
| Criado (wallet) | 201 |
| Processado / replay | 200 |
| Aceito, aguardando referência | 202 |
| Payload inválido, header ausente, cursor inválido | 400 |
| Não encontrado | 404 |
| Conflito (wallet duplicada, key com outro payload) | 409 |
| Rejeitada por regra de negócio | 422 (corpo com `failureCode`) |
| Falha transitória de infraestrutura | 503 |

O provedor decide reenviar apenas pelo status: 503 reenvia a mesma key; 400/409/422 não.

## 10. REFUND e ROLLBACK

- Referência resolvida por `(providerId, referenceExternalTransactionId)` e validada: mesmo provider, player, wallet, moeda, rodada e **valor**.
- REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND. A direção do ROLLBACK é a inversa da referência.
- **Interpretação adotada**: REFUND e ROLLBACK da mesma transação **bloqueiam um ao outro** (`ALREADY_REVERSED`). Se ambos pudessem
  processar, o dinheiro voltaria duas vezes. O índice parcial só impede o mesmo tipo duas vezes; o caso cruzado é
  tratado dentro do lock da wallet.
- Referência ausente: `PENDING_REFERENCE` (HTTP 202) e evento. Um worker reprocessa com **backoff exponencial**
  (5s * 2^tentativas, teto 10 min). Limite padrão: **8 tentativas**. Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` e evento.
  Justificativa: tempo suficiente para um atraso normal de entrega, sem manter pendência indefinida.
- Referência ainda `PENDING_REFERENCE` (reversão de reversão): também espera.
- **WIN com referência**: o enunciado diz que pode referenciar a BET, mas o schema só permite referência em
  REFUND/ROLLBACK. Interpretação: a referência de BET/WIN/LOSS é ignorada (WIN não depende dela).

## 11. Outbox transacional

- Eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` só quando o saldo muda,
  `WagerTransactionPendingReference`) são gravados **na mesma transação** do saldo e do ledger. Nada é publicado antes do commit.
- Envelope: `eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt`, `version`, `data` (com `MoneyProps`, nunca `Money`).
- Publisher: lote com `FOR UPDATE SKIP LOCKED` (vários publishers concorrentes não pegam as mesmas linhas), publica, marca
  `published_at`, COMMIT. Falha: `attempts + 1` e `next_attempt_at` com backoff exponencial.
- Garantia: **at-least-once**. Se o processo morre antes do COMMIT, o lock cai e outra instância publica (pode duplicar, nunca perde).
  Consumidores devem deduplicar por `eventId`.
- Testado: dois publishers concorrentes sem duplicar, retry com backoff, rollback sem perder evento.

## 12. Autenticação

**Não implementada**, como permitido pela seção 2 do desafio (não vale pontos). Desenho: um IdP externo (Keycloak, OIDC)
com validação de JWT em um `AuthGuard` global, `/health/*` aberto. O ponto de extensão existe: `src/auth/auth.guard.ts`
(no-op) registrado como `APP_GUARD`.

## 13. Observabilidade

Parcial. Há logs do Nest em pontos-chave (falha transitória sem payload financeiro, divergência de reconciliação em JSON, eventos
publicados), `/health/live` e `/health/ready` (checa Postgres). **Não há métricas** (contadores por status, DLQ, lag) nem logs
JSON estruturados em todo o fluxo. O lag da outbox já pode ser calculado por `OutboxDispatcher.lagSeconds()`, mas não é exposto.

## 14. Limitações conhecidas (honestas)

1. **SQS implementado com limites**: consumidor, inbox na mesma transação, DLQ para erro permanente e shutdown limpo existem e têm teste com LocalStack. **Não testado**: a movimentação automática para a DLQ após 5 recebimentos (retry transitório) e o crash entre commit e ack.
   Desenho: consumidor de `wager-transactions.fifo` que, numa transação, insere em `inbox_messages` (`ON CONFLICT DO NOTHING`), chama o **mesmo**
   `SubmitWagerTransactionUseCase` e só então faz ack; erro de negócio = ack (terminal), transitório = não faz ack (visibilidade/backoff),
   permanente ou acima do limite = DLQ. FIFO não é a garantia final: o banco continua dono das invariantes.
2. **O publisher da outbox publica em `wager-events.fifo`** (`SqsEventPublisher`); sem teste automatizado de publicação em SQS real. Trocar por SQS/SNS exige só uma nova implementação da porta `EventPublisher`.
3. O publisher chama o broker **dentro** da transação (com locks de linha da outbox). Simples e correto para at-least-once, mas um broker lento
   segura a transação. Alternativa: marcar com lease e publicar fora.
4. Eventos e inbox/outbox não são classes de domínio (`IntegrationEvent`, `InboxMessage`, `OutboxMessage`): o evento é um objeto montado no helper.
5. Sem teste com 3 ou mais processos, sem teste de carga, sem teste de crash entre commit e ack (não há ack).
6. Triggers do ledger podem ser removidos pelo dono do banco; em produção a aplicação usaria um usuário sem esse privilégio.
7. Ids são UUID v4 (`randomUUID`), não v7.
8. Os testes de integração exigem o servidor parado (ou `OUTBOX_DISABLED=true`) e rodam arquivo a arquivo.
9. `/health/ready` não verifica SQS (não é usado).
10. Reversão parcial está fora de escopo, como no enunciado.

