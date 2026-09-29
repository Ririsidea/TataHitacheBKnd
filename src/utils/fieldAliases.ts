import type { Request } from 'express';

// The employee fields were renamed (employeeName -> name, employeeEmail -> email). Callers that
// still send an old name keep working for now: the old name is accepted as an alias, the new name
// wins when both are sent, and every use of an old name is logged so it can be tracked down.
export const RENAMED_FIELDS = { name: 'employeeName', email: 'employeeEmail' } as const;

export type RenamedField = keyof typeof RENAMED_FIELDS;

/** The value under the new name, else under the old name, else undefined (no logging). */
export function pickRenamed(source: Record<string, unknown>, field: RenamedField): unknown {
  return source[field] !== undefined ? source[field] : source[RENAMED_FIELDS[field]];
}

/** Logs a deprecation warning for every old name present in `source` (a request body or query). */
export function warnDeprecatedNames(req: Request, source: Record<string, unknown>, where: string): void {
  for (const [field, oldName] of Object.entries(RENAMED_FIELDS)) {
    if (source[oldName] !== undefined) {
      console.warn(`[${req.id}] [deprecated] ${req.method} ${req.path}: ${where} "${oldName}" is deprecated - send "${field}"`);
    }
  }
}

/** pickRenamed + the deprecation warning for that one field. */
export function readRenamed(req: Request, source: Record<string, unknown>, field: RenamedField, where: string): unknown {
  const oldName = RENAMED_FIELDS[field];
  if (source[oldName] !== undefined) {
    console.warn(`[${req.id}] [deprecated] ${req.method} ${req.path}: ${where} "${oldName}" is deprecated - send "${field}"`);
  }
  return pickRenamed(source, field);
}
