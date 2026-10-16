/**
 * Taxonomia de falhas (estavel e legivel por maquina).
 * Toda transacao REJECTED ou FAILED carrega exatamente um destes codigos.
 */
export enum FailureCode {
  /** BET sem saldo suficiente. Terminal: o provedor deve usar outro id para tentar de novo. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversao (REFUND/ROLLBACK) que deixaria o saldo negativo. Diferente de uma aposta sem saldo. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Referencia nunca apareceu (limite de tentativas esgotado). */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referencia de outro provider, player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo da referencia incompativel (ex.: REFUND de um WIN). */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** Referencia existe mas foi REJECTED ou FAILED, entao nao ha o que reverter. */
  ReferenceNotApplied = 'REFERENCE_NOT_APPLIED',
  /** Referencia ja revertida pelo mesmo tipo de operacao. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Valor da reversao diferente do valor da referencia. */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** Moeda da operacao diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Wallet inexistente. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** Erro permanente de infraestrutura (usado em FAILED). */
  InternalError = 'INTERNAL_ERROR',
}
