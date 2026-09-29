import pincode from '@devzoy/indian-pincode';
import { lookup, type PostOffice } from '@devzoy/indian-pincode-geo';

export type AddressValidationCode =
  | 'INVALID_COUNTRY'
  | 'INVALID_PIN'
  | 'PIN_STATE_MISMATCH'
  | 'CITY_REQUIRED'
  | 'PIN_CITY_MISMATCH';

export interface AddressValidationInput {
  country: unknown;
  state: unknown;
  city: unknown;
  pincode: unknown;
}

export interface ValidatedAddress {
  valid: true;
  pincode: string;
  state: string;
  city: string;
}

export interface InvalidAddress {
  valid: false;
  code: AddressValidationCode;
  message: string;
}

export type AddressValidationResult = ValidatedAddress | InvalidAddress;

const STATE_ALIASES: Record<string, string> = {
  orissa: 'odisha',
  pondicherry: 'puducherry',
  uttaranchal: 'uttarakhand',
};

// City names the dataset and everyday usage spell differently - matched either way, both
// for a submitted address (validateIndianAddress) and nowhere else (the cities list a PIN
// returns always uses the dataset's own spelling, e.g. "Bengaluru", not "Bangalore").
const CITY_ALIASES: Record<string, string> = {
  bangalore: 'bengaluru',
  bombay: 'mumbai',
  gurgaon: 'gurugram',
};

export function normalizeLocationName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeStateName(state: string): string {
  const normalized = normalizeLocationName(state);
  return STATE_ALIASES[normalized] || normalized;
}

export function statesMatch(a: string, b: string): boolean {
  return normalizeStateName(a) === normalizeStateName(b);
}

function canonicalCityKey(city: string): string {
  const normalized = normalizeLocationName(city);
  return CITY_ALIASES[normalized] || normalized;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Junk left over from parsing office names: bare numbers, 1-2 letter codes (postal admin
// shorthand, not a place name), and a handful of known non-city office labels.
const JUNK_CITY_NAMES = new Set(['parcel', 'airport', 'ndc', 'hpo']);

function isJunkCityName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (/^\d+$/.test(trimmed)) return true;
  if (trimmed.replace(/\s+/g, '').length <= 2) return true;
  return JUNK_CITY_NAMES.has(trimmed.toLowerCase());
}

/**
 * Post-office names contain office-type suffixes (GPO, S.O., B.O.) and may include
 * a parenthesized city. The package does not expose a separate city field, so these
 * are the only location names considered.
 */
function officeCityNames(officeName: string, officeType: PostOffice['officeType']): string[] {
  const normalized = normalizeLocationName(officeName);
  const parenthesized = [...officeName.matchAll(/\(([^)]+)\)/g)].map((match) => normalizeLocationName(match[1]));
  const cityName = normalized.replace(/\b(?:gpo|ho)\b/g, '').replace(/\s+/g, ' ').trim();
  const names = [...parenthesized];
  if (officeType === 'HO' || /\b(?:gpo|ho)\b/.test(normalized)) names.push(cityName);
  return [...new Set(names.filter(Boolean))];
}

// A district name "as is" and, when it carries one, a second variant with the trailing
// Urban/Rural split dropped (e.g. "Bengaluru Urban" -> also "Bengaluru").
function districtNameVariants(district: string): string[] {
  const base = normalizeLocationName(district);
  const stripped = base.replace(/\b(?:urban|rural)\b/g, '').replace(/\s+/g, ' ').trim();
  return stripped && stripped !== base ? [base, stripped] : [base];
}

export interface PincodeInfo {
  pincode: string;
  state: string;
  district: string;
  /** Every valid city name for this PIN (district names + HO/GPO + post-office area names), title-cased and de-duplicated. */
  cities: string[];
}

export type PincodeLookupResult = { info: PincodeInfo; error?: undefined } | { error: 'INVALID_FORMAT' | 'NOT_FOUND'; info?: undefined };

// The one place the "valid cities for this PIN" list is built - used by GET
// /api/map/pincode/:pin (so the frontend can offer it as a dropdown) and by
// validateIndianAddress below (so create-order checks a submitted city against the
// exact same list), so the two can never drift apart.
export function lookupPincode(pin: string): PincodeLookupResult {
  const trimmed = stringValue(pin);
  if (!pincode.isWellFormed(trimmed)) return { error: 'INVALID_FORMAT' };
  if (!pincode.validate(trimmed)) return { error: 'NOT_FOUND' };

  const state = pincode.getState(trimmed) || '';
  const districts = pincode.getDistricts(trimmed);
  const offices = lookup(trimmed);

  const cityNames = new Set<string>();
  for (const district of districts) {
    for (const variant of districtNameVariants(district)) {
      if (!isJunkCityName(variant)) cityNames.add(toTitleCase(variant));
    }
  }
  for (const office of offices) {
    for (const raw of officeCityNames(office.officeName, office.officeType)) {
      if (!isJunkCityName(raw)) cityNames.add(toTitleCase(raw));
    }
  }

  return {
    info: {
      pincode: trimmed,
      state: toTitleCase(state),
      district: districts[0] ? toTitleCase(districts[0]) : '',
      cities: [...cityNames].sort((a, b) => a.localeCompare(b)),
    },
  };
}

function invalid(code: AddressValidationCode, message: string): InvalidAddress {
  return { valid: false, code, message };
}

export function validateIndianAddress(input: AddressValidationInput): AddressValidationResult {
  const country = stringValue(input.country);
  if (normalizeLocationName(country) !== 'india') {
    return invalid('INVALID_COUNTRY', 'The address country must be India.');
  }

  const pin = stringValue(input.pincode);
  const result = lookupPincode(pin);
  if (result.error !== undefined) {
    return invalid('INVALID_PIN', 'The PIN code does not exist in the Indian PIN code dataset.');
  }

  const state = stringValue(input.state);
  if (!state || !statesMatch(result.info.state, state)) {
    return invalid('PIN_STATE_MISMATCH', 'The selected state does not match the PIN code.');
  }

  const city = stringValue(input.city);
  if (!city) {
    return invalid('CITY_REQUIRED', 'City is required.');
  }
  const wanted = canonicalCityKey(city);
  if (!result.info.cities.some((c) => canonicalCityKey(c) === wanted)) {
    return invalid('PIN_CITY_MISMATCH', 'The selected city does not match the PIN code.');
  }

  return { valid: true, pincode: result.info.pincode, state: result.info.state.toUpperCase(), city: city.toUpperCase() };
}
