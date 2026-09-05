const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Backoff exponencial com jitter (±30%), cap de 5 minutos. Usado tanto
 * pelo reprocessamento de PENDING_REFERENCE quanto, com os mesmos
 * parâmetros, pelo publicador de outbox (ver OutboxMessage.scheduleRetry,
 * que replica esta fórmula no agregado de domínio). */
export function computeBackoff(attempts: number, now: Date = new Date()): Date {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * 0.3 * exponential);
  return new Date(now.getTime() + exponential + jitter);
}
