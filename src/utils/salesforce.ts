/**
 * Computes the Salesforce 3-char case-safe checksum suffix from a 15-char Id.
 * Each 5-char chunk of the prefix encodes a 5-bit number (bit i = 1 iff the
 * i-th char is uppercase A-Z); the bit value 0..31 maps to A..Z then 0..5.
 */
export function computeIdSuffix(id15: string): string {
  let suffix = '';
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const c = id15.charAt(chunk * 5 + i);
      if (c >= 'A' && c <= 'Z') bits |= 1 << i;
    }
    suffix +=
      bits < 26
        ? String.fromCharCode(65 + bits) // 'A'..'Z'
        : String.fromCharCode(48 + bits - 26); // '0'..'5'
  }
  return suffix;
}

/**
 * Returns true iff `value` is an 18-char Salesforce record Id with a valid
 * case-safe checksum suffix. 15-char Ids are intentionally not recognised:
 * SOQL returns 18-char Ids for every supported API version, and 15-char
 * strings have no verifiable structure (false-positive rate is too high).
 */
export function isSalesforceRecordId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 18) return false;
  if (!/^[a-zA-Z0-9]{15}[A-Z0-5]{3}$/.test(value)) return false;
  return computeIdSuffix(value.slice(0, 15)) === value.slice(15);
}
