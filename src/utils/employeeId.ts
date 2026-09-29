// Employee ID: exactly 5 digits, stored as a string so a leading zero (e.g. "01234") survives.
export const EMPLOYEE_ID_PATTERN = /^\d{5}$/;

export function isValidEmployeeId(value: unknown): value is string {
  return typeof value === 'string' && EMPLOYEE_ID_PATTERN.test(value);
}
