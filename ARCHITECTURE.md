# ARCHITECTURE

Este documento registra as decisões técnicas do projeto, os motivos e as limitações conhecidas. Ele é atualizado ao longo do desenvolvimento.

## 1. Stack

- Runtime / gerenciador de pacotes / test runner: Bun
- Linguagem: TypeScript em modo estrito
- Framework: NestJS
- Banco: PostgreSQL 16
- Mensageria: AWS SQS via LocalStack 3.8 (versões mais novas exigem token de licença)
- Orquestração local: Docker Compose

## 2. Autenticação

**Decisão:** autenticação não implementada neste desafio.

**Motivo:** a seção 2 do desafio informa que autenticação não vale pontos e aceita a omissão, desde que documentada. O tempo foi priorizado para correção financeira, concorrência e idempotência.

**Desenho que seria adotado:** integração com um Identity Provider externo (por exemplo Keycloak, via OIDC), validando o JWT em um AuthGuard global. Os endpoints de health ficariam abertos.

**Ponto de extensão:** um AuthGuard no-op será deixado no código, para ser substituído pela implementação real.

## 3. Money

**Representação:** valor como string decimal com escala fixa de 2 casas, calculado com decimal.js. Nunca é usado number para dinheiro.

**Entradas aceitas:** (a definir) ex.: "10" e "10.5" são normalizados para "10.00" e "10.50", ou rejeitados.

**Entradas rejeitadas:** string vazia, NaN, Infinity, notação científica, mais de 2 casas decimais e valores negativos em contratos de entrada.

**Persistência:** (a definir) colunas separadas de valor (numeric) e moeda.

## 4. Banco de dados e constraints

(a preencher)

| Regra | Garantida por |
|---|---|
| Uma wallet por playerId + currency | (a definir) |
| Saldo nunca negativo | (a definir) |
| Idempotency key única | (a definir) |
| Ledger imutável | (a definir) |
| Inbox sem duplicata | (a definir) |
| Referência não revertida duas vezes | (a definir) |

## 5. Controle de concorrência

(a preencher: estratégia escolhida e justificativa)

## 6. Idempotência

(a preencher: algoritmo do payloadHash e tratamento de conflito)

## 7. Máquina de estados da WagerTransaction

(a preencher: transições válidas)

## 8. Códigos de falha

(a preencher: taxonomia dos failureCode)

## 9. Mapeamento de status HTTP

(a preencher)

## 10. Mensageria (Inbox, Outbox, SQS)

(a preencher)

## 11. Trade-offs e limitações

(a preencher ao final, com honestidade sobre o que ficou de fora)
