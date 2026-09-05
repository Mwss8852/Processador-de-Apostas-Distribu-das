export interface CursorPayload {
  createdAt: Date;
  id: string;
}

/** Cursor opaco e estável: base64 de `${isoTimestamp}|${id}`. Keyset
 * pagination (WHERE createdAt < cursor.createdAt) evita os problemas de
 * OFFSET (itens pulados/repetidos sob escrita concorrente). */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(`${payload.createdAt.toISOString()}|${payload.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, id] = raw.split('|');
  if (!iso || !id) throw new Error('Invalid cursor');
  return { createdAt: new Date(iso), id };
}
