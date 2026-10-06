// Ticket ID: exactly 5 digits, stored as a string so a leading zero (e.g. "01234") survives.
// Same shape as employeeId.ts on purpose - the two fields look identical but are never
// cross-checked: a login's loginType alone decides which column is queried (see
// controllers/auth.controller.ts), so the same 5 digits can be one user's employeeId and a
// different user's (or the same user's) ticketId without conflict.
export const TICKET_ID_PATTERN = /^\d{5}$/;

export function isValidTicketId(value: unknown): value is string {
  return typeof value === 'string' && TICKET_ID_PATTERN.test(value);
}
