export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

/** Log estruturado em JSON, uma linha por evento. Nunca passe payload financeiro completo. */
export function logJson(level: 'info' | 'warn' | 'error', event: string, ctx: LogContext = {}): void {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...ctx }) + '\n',
  );
}
