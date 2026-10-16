import type { Pool, PoolClient } from 'pg';

/**
 * Executa `work` dentro de uma transacao SQL.
 * COMMIT se resolver, ROLLBACK se lancar. Sempre devolve o client ao pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignora falha no rollback; o erro original e o que importa
    }
    throw error;
  } finally {
    client.release();
  }
}
