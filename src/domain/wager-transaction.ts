import { FailureCode } from './failure-code.js';
import { Money } from './money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export class InvalidTransactionStateError extends Error {
  constructor(from: WagerTransactionStatus, to: WagerTransactionStatus) {
    super(`transicao invalida: ${from} -> ${to}`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class InvalidTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionError';
  }
}

const S = WagerTransactionStatus;

/** Transicoes validas. PROCESSED, REJECTED e FAILED sao terminais. */
const TRANSITIONS: Record<WagerTransactionStatus, WagerTransactionStatus[]> = {
  [S.Pending]: [S.PendingReference, S.Processed, S.Rejected, S.Failed],
  [S.PendingReference]: [S.PendingReference, S.Processed, S.Rejected, S.Failed],
  [S.Processed]: [],
  [S.Rejected]: [],
  [S.Failed]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  /** Somente o sistema pode criar OPENING. */
  internal?: boolean;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigencia de referencia por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening && !props.internal) {
      throw new InvalidTransactionError('OPENING e interno e nao pode ser submetido');
    }
    if (props.money.isNegative()) {
      throw new InvalidTransactionError('o valor nao pode ser negativo');
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidTransactionError('o valor deve ser positivo (somente LOSS aceita zero)');
    }

    const needsReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsReference && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${props.kind} exige referenceExternalTransactionId`);
    }
    // Interpretacao: a referencia so e guardada para REFUND e ROLLBACK (o schema exige isso).
    const reference = needsReference ? props.referenceExternalTransactionId : undefined;

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Reconstrucao a partir da persistencia: nao revalida transicoes. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transicoes (lancam InvalidTransactionStateError se invalidas)
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
  }

  reject(code: FailureCode): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
  }

  // ---- consultas de dominio
  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direcao do lancamento no ledger. ROLLBACK e o inverso da referencia.
   * LOSS nao gera lancamento, entao pedir a direcao dele e erro de programacao.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionError('ROLLBACK exige a transacao referenciada');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError('LOSS nao gera lancamento');
    }
  }

  /**
   * Valida esta reversao contra a transacao referenciada.
   * Devolve o FailureCode da violacao, ou undefined se estiver tudo certo.
   * Pressupoe que a referencia ja foi encontrada e esta PROCESSED (o use case trata os demais estados).
   */
  validateAgainst(reference: WagerTransaction): FailureCode | undefined {
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotApplied;
    }
    const allowed =
      this.kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
    if (!allowed.includes(reference.kind)) {
      return FailureCode.InvalidReferenceKind;
    }
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (!reference.money.equals(this.money)) {
      return FailureCode.AmountMismatch;
    }
    return undefined;
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this._status, next);
    }
    this._status = next;
  }
}
