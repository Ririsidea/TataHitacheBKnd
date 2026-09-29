import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIndianAddress } from '../src/services/pincode.service';

const address = (overrides: Record<string, unknown> = {}) => ({
  country: 'India',
  state: 'Maharashtra',
  city: 'Nagpur',
  pincode: '440001',
  ...overrides,
});

test('accepts a PIN-backed city and state', () => {
  assert.deepEqual(validateIndianAddress(address()), {
    valid: true,
    pincode: '440001',
    state: 'MAHARASHTRA',
    city: 'NAGPUR',
  });
});

test('rejects a PIN that does not exist', () => {
  const result = validateIndianAddress(address({ pincode: '999999' }));
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.code, 'INVALID_PIN');
});

test('rejects a state mismatch', () => {
  const result = validateIndianAddress(address({ state: 'Delhi' }));
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.code, 'PIN_STATE_MISMATCH');
});

test('rejects a city that is not represented by the PIN post-office locations', () => {
  const result = validateIndianAddress(address({ pincode: '442203' }));
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.code, 'PIN_CITY_MISMATCH');
});

test('normalizes PIN whitespace and state/city case', () => {
  const result = validateIndianAddress(address({ pincode: ' 440001 ', state: '  maHARASHTRA  ', city: ' nagpur ' }));
  assert.equal(result.valid, true);
});

test('rejects empty, non-numeric, and seven-digit PINs', () => {
  for (const pincode of ['', 'abcdef', '4400011']) {
    const result = validateIndianAddress(address({ pincode }));
    assert.equal(result.valid, false, pincode);
    if (!result.valid) assert.equal(result.code, 'INVALID_PIN', pincode);
  }
});

test('rejects non-India countries', () => {
  const result = validateIndianAddress(address({ country: 'United States' }));
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.code, 'INVALID_COUNTRY');
});

