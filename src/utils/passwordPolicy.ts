export const MIN_LENGTH = 7;
const LETTER_RE = /[A-Za-z]/;
const NUMBER_RE = /[0-9]/;
const SPECIAL_RE = /[^A-Za-z0-9]/;

export type PasswordCheck = { valid: true; message: null } | { valid: false; message: string };

// Shared by the seed script and the reset-password endpoint so the rule lives in one place.
export function validatePassword(password: unknown): PasswordCheck {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    return { valid: false, message: `Password must be at least ${MIN_LENGTH} characters long` };
  }
  if (!LETTER_RE.test(password)) {
    return { valid: false, message: 'Password must contain at least one letter' };
  }
  if (!NUMBER_RE.test(password)) {
    return { valid: false, message: 'Password must contain at least one number' };
  }
  if (!SPECIAL_RE.test(password)) {
    return { valid: false, message: 'Password must contain at least one special character' };
  }
  return { valid: true, message: null };
}
