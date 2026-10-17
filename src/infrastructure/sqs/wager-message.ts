import type { SubmitInput } from '../../application/submit-wager-transaction.use-case.js';

/** Mensagem que nunca vai dar certo (malformada, tipo desconhecido, wallet inexistente): vai para a DLQ. */
export class PermanentMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

export interface ParsedMessage {
  messageId: string;
  input: SubmitInput;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new PermanentMessageError(`campo invalido: ${field}`);
  }
  return value;
}

export function parseWagerMessage(body: string | undefined): ParsedMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? '');
  } catch {
    throw new PermanentMessageError('json invalido');
  }
  if (typeof raw !== 'object' || raw === null) throw new PermanentMessageError('corpo invalido');
  const m = raw as Record<string, unknown>;

  const messageId = str(m.messageId, 'messageId');
  if (m.type !== 'WagerTransactionRequested') throw new PermanentMessageError('type desconhecido');
  if (typeof m.data !== 'object' || m.data === null) throw new PermanentMessageError('data ausente');
  const d = m.data as Record<string, unknown>;
  const money = (d.money ?? {}) as Record<string, unknown>;

  const playerId = str(d.playerId, 'playerId');
  const walletId = str(d.walletId, 'walletId');
  if (!UUID.test(playerId) || !UUID.test(walletId)) {
    throw new PermanentMessageError('playerId e walletId devem ser UUID');
  }

  const input: SubmitInput = {
    idempotencyKey: str(d.idempotencyKey, 'idempotencyKey'),
    providerId: str(d.providerId, 'providerId'),
    externalTransactionId: str(d.externalTransactionId, 'externalTransactionId'),
    playerId: playerId.toLowerCase(),
    walletId: walletId.toLowerCase(),
    roundId: str(d.roundId, 'roundId'),
    gameId: str(d.gameId, 'gameId'),
    kind: str(d.kind, 'kind'),
    money: { amount: str(money.amount, 'money.amount'), currency: str(money.currency, 'money.currency') },
  };
  if (d.referenceExternalTransactionId !== undefined) {
    input.referenceExternalTransactionId = str(
      d.referenceExternalTransactionId,
      'referenceExternalTransactionId',
    );
  }
  return { messageId, input };
}
