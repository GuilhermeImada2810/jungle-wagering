import { describe, expect, test } from 'bun:test';
import { FailureCode } from './failure-code.js';
import { Money } from './money.js';
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from './wager-transaction.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-16T12:00:00.000Z');

let seq = 0;
const make = (kind: K, over: Record<string, unknown> = {}) => {
  seq += 1;
  return WagerTransaction.create({
    id: `id-${seq}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: 'hash-1',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('25.00'),
    createdAt: at,
    ...(kind === K.Refund || kind === K.Rollback
      ? { referenceExternalTransactionId: 'ext-ref' }
      : {}),
    ...over,
  });
};

const processedBet = () => {
  const bet = make(K.Bet);
  bet.markProcessed(undefined, at);
  return bet;
};

describe('WagerTransaction.create', () => {
  test('nasce em PENDING', () => {
    expect(make(K.Bet).status).toBe(S.Pending);
  });

  test('REFUND e ROLLBACK exigem referencia', () => {
    expect(() => make(K.Refund, { referenceExternalTransactionId: undefined })).toThrow(
      InvalidTransactionError,
    );
    expect(() => make(K.Rollback, { referenceExternalTransactionId: undefined })).toThrow(
      InvalidTransactionError,
    );
  });

  test('OPENING nao pode ser submetido, so criado internamente', () => {
    expect(() => make(K.Opening)).toThrow(InvalidTransactionError);
    expect(make(K.Opening, { internal: true }).kind).toBe(K.Opening);
  });

  test('somente LOSS aceita valor zero', () => {
    expect(make(K.Loss, { money: brl('0.00') }).kind).toBe(K.Loss);
    expect(() => make(K.Bet, { money: brl('0.00') })).toThrow(InvalidTransactionError);
  });

  test('referencia de BET/WIN e ignorada (so REFUND/ROLLBACK guardam)', () => {
    const win = make(K.Win, { referenceExternalTransactionId: 'ext-bet' });
    expect(win.referenceExternalTransactionId).toBeUndefined();
  });
});

describe('WagerTransaction transicoes', () => {
  test('PENDING -> PROCESSED guarda data e referencia', () => {
    const t = make(K.Refund);
    t.markProcessed('ref-id', at);
    expect(t.status).toBe(S.Processed);
    expect(t.processedAt).toEqual(at);
    expect(t.referenceTransactionId).toBe('ref-id');
    expect(t.isTerminal()).toBe(true);
  });

  test('PENDING -> PENDING_REFERENCE -> PENDING_REFERENCE -> REJECTED', () => {
    const t = make(K.Refund);
    t.markPendingReference();
    expect(t.isTerminal()).toBe(false);
    t.markPendingReference();
    t.reject(FailureCode.ReferenceNotFound);
    expect(t.status).toBe(S.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('FAILED guarda o codigo', () => {
    const t = make(K.Bet);
    t.fail(FailureCode.InternalError);
    expect(t.status).toBe(S.Failed);
    expect(t.failureCode).toBe(FailureCode.InternalError);
  });

  test.each(['markProcessed', 'markPendingReference', 'reject', 'fail'] as const)(
    'estado terminal nao aceita %s',
    (method) => {
      const t = make(K.Bet);
      t.reject(FailureCode.InsufficientFunds);
      expect(() => {
        if (method === 'markProcessed') t.markProcessed(undefined, at);
        else if (method === 'markPendingReference') t.markPendingReference();
        else if (method === 'reject') t.reject(FailureCode.InsufficientFunds);
        else t.fail(FailureCode.InternalError);
      }).toThrow(InvalidTransactionStateError);
    },
  );
});

describe('WagerTransaction consultas', () => {
  test('affectsBalance e false so para LOSS', () => {
    expect(make(K.Loss).affectsBalance()).toBe(false);
    expect(make(K.Bet).affectsBalance()).toBe(true);
  });

  test('requiresReference', () => {
    expect(make(K.Refund).requiresReference()).toBe(true);
    expect(make(K.Rollback).requiresReference()).toBe(true);
    expect(make(K.Bet).requiresReference()).toBe(false);
  });

  test('matchesPayload compara o hash', () => {
    const t = make(K.Bet);
    expect(t.matchesPayload('hash-1')).toBe(true);
    expect(t.matchesPayload('outro')).toBe(false);
  });
});

describe('WagerTransaction.ledgerDirectionFor', () => {
  test('BET debita; WIN, REFUND e OPENING creditam', () => {
    expect(make(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(K.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(K.Opening, { internal: true }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK e o inverso da referencia', () => {
    const rb = make(K.Rollback);
    expect(rb.ledgerDirectionFor(make(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(make(K.Win))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(make(K.Refund))).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem referencia e LOSS sao erros', () => {
    expect(() => make(K.Rollback).ledgerDirectionFor()).toThrow(InvalidTransactionError);
    expect(() => make(K.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction.validateAgainst', () => {
  test('REFUND valido de uma BET processada', () => {
    expect(make(K.Refund).validateAgainst(processedBet())).toBeUndefined();
  });

  test('referencia nao processada', () => {
    const bet = make(K.Bet);
    expect(make(K.Refund).validateAgainst(bet)).toBe(FailureCode.ReferenceNotApplied);
  });

  test('REFUND so referencia BET', () => {
    const win = make(K.Win);
    win.markProcessed(undefined, at);
    expect(make(K.Refund).validateAgainst(win)).toBe(FailureCode.InvalidReferenceKind);
  });

  test('ROLLBACK aceita WIN', () => {
    const win = make(K.Win);
    win.markProcessed(undefined, at);
    expect(make(K.Rollback).validateAgainst(win)).toBeUndefined();
  });

  test('rodada, player, wallet ou provider diferentes', () => {
    expect(make(K.Refund, { roundId: 'round-2' }).validateAgainst(processedBet())).toBe(
      FailureCode.ReferenceMismatch,
    );
    expect(make(K.Refund, { playerId: 'p2' }).validateAgainst(processedBet())).toBe(
      FailureCode.ReferenceMismatch,
    );
    expect(make(K.Refund, { walletId: 'w2' }).validateAgainst(processedBet())).toBe(
      FailureCode.ReferenceMismatch,
    );
    expect(make(K.Refund, { providerId: 'provider-b' }).validateAgainst(processedBet())).toBe(
      FailureCode.ReferenceMismatch,
    );
  });

  test('valor diferente da referencia', () => {
    expect(make(K.Refund, { money: brl('10.00') }).validateAgainst(processedBet())).toBe(
      FailureCode.AmountMismatch,
    );
  });
});
