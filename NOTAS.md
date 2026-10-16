# Anotações (rascunho)

- 15/10: LocalStack 3.8, porque as versões novas exigem token de licença.
- 15/10: Autenticação não implementada, porque o desafio não dá pontos e aceita a omissão.
- Money aceita "10" e normaliza para "10.00", porque facilita a integração.
- Money aceita "10" e "10.5" e normaliza para "10.00"/"10.50" na saída; rejeita mais de 2 casas para nunca arredondar dinheiro em silêncio.
- Concorrência: SELECT ... FOR UPDATE por wallet. Testado no psql: a segunda transação espera a primeira terminar e lê o saldo já atualizado. Não há lock global; só a linha da wallet é travada.
- Banco: CHECK (balance >= 0) e INSERT ... ON CONFLICT testados manualmente.
- Schema wallets testado no psql: UNIQUE(player_id, currency), CHECK(balance >= 0) e CHECK de moeda ISO funcionam. Banco é a última linha de defesa.
- Schema wallet_ledger_entries: UNIQUE(transaction_id, wallet_id); CHECK de aritmética (antes ± valor = depois); triggers BEFORE UPDATE/DELETE/TRUNCATE tornam o ledger append-only. Testado no psql.
- Limitação: o dono do banco pode remover os triggers; em produção a aplicação usaria um usuário sem esse privilégio.
- Evitar acentos em mensagens de erro do banco (console do Windows mostra ?).   
- Wallet: debit/credit devolvem a WalletLedgerEntry; saldo e ledger mudam juntos ou nada muda (o ledger e criado antes de alterar o estado).
- Wallet: version incrementa so quando o saldo muda; erros de dominio proprios (InsufficientFundsError, InvalidAmountError, CurrencyMismatchError).
Transições válidas:
PENDING pode ir para PENDING_REFERENCE, PROCESSED, REJECTED ou FAILED.
PENDING_REFERENCE pode ir para PENDING_REFERENCE (nova tentativa que continua sem referência), PROCESSED, REJECTED ou FAILED.
PROCESSED, REJECTED e FAILED são terminais. Transicionar a partir deles lança InvalidTransactionStateError.
OPENING só pode ser criado com internal: true, então API e fila nunca o criam.
Referência em WIN: o desafio diz que o WIN "pode referenciar" a BET, mas o CHECK wt_reference_ck do banco só permite referência em REFUND e ROLLBACK. Decisão: o domínio ignora a referência de BET, WIN, LOSS e OPENING. Documente isso como interpretação no ARCHITECTURE.md.
Valores: o valor nunca é negativo. Só LOSS aceita zero, e os demais tipos exigem valor positivo.
Direção do ROLLBACK: é o inverso da direção da referência (BET debitou, então o rollback credita; WIN ou REFUND creditaram, então o rollback debita).
- WagerTransaction: transicoes PENDING -> {PENDING_REFERENCE, PROCESSED, REJECTED, FAILED}; PENDING_REFERENCE -> {PENDING_REFERENCE, PROCESSED, REJECTED, FAILED}; PROCESSED/REJECTED/FAILED terminais.
- Referencia so guardada para REFUND/ROLLBACK (CHECK do schema); WIN com referencia: ignorada. Documentar como interpretacao.
- FailureCode: INSUFFICIENT_FUNDS e REVERSAL_INSUFFICIENT_FUNDS distintos; REFERENCE_NOT_FOUND quando esgota as tentativas.
- Limitacao: REFUND + ROLLBACK da mesma BET nao e barrado pelo indice, tratado no use case sob lock da wallet.
- payloadHash: SHA-256 (hex) do JSON canonico (chaves ordenadas, sem espacos) so dos campos de negocio; Idempotency-Key e metadados de transporte ficam fora. Valor normalizado a 2 casas.
- Mesma key com hash diferente = conflito (409); mesma key com mesmo hash = replay.
- Caminho critico de escrita (lock, idempotencia, ledger, outbox) com SQL explicito via `pg` (node-postgres): BEGIN / SELECT ... FOR UPDATE / COMMIT. MikroORM fica com migrations e mapeamento. Motivo: SQL auditavel e menos incerteza de API no MikroORM 7.