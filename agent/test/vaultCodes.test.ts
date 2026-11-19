import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { base32Decode, base32Encode } from '../src/vault/base32';
import { toBase64, utf8Encode } from '../src/vault/bytes';
import { combineMigrationBatches, parseMigrationUri, type MigrationBatch } from '../src/vault/migration';
import { generateCode, hotp, secondsRemaining, steamGuard, totp, validateOtpParams, type OtpParams } from '../src/vault/otp';
import { formatOtpAuthUri, parseOtpAuthUri, type OtpAccount } from '../src/vault/otpauth';

const ascii = (text: string) => utf8Encode(text);
const RFC_SHA1_SEED = ascii('12345678901234567890');
const RFC_SHA256_SEED = ascii('12345678901234567890123456789012');
const RFC_SHA512_SEED = ascii('1234567890123456789012345678901234567890123456789012345678901234');
const RFC_SHA1_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('encodes the RFC 4648 test vectors without padding', () => {
    const vectors: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
    for (const [plain, encoded] of vectors) {
      assert.equal(base32Encode(ascii(plain)), encoded);
      assert.deepEqual(base32Decode(encoded), ascii(plain));
    }
  });

  it('decodes lower case, spaces, dashes and padding', () => {
    assert.deepEqual(base32Decode('mzxw-6ytb oi======'), ascii('foobar'));
  });

  it('rejects characters outside the alphabet without echoing them', () => {
    assert.throws(() => base32Decode('MZXW1'), (error: Error) => /not valid base32/.test(error.message) && !error.message.includes('MZXW1'));
  });
});

describe('HOTP (RFC 4226 Appendix D)', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it('matches all ten published values', () => {
    expected.forEach((code, counter) => assert.equal(hotp(RFC_SHA1_SEED, counter, 6, 'SHA1'), code, `counter ${counter}`));
  });

  it('accepts counters above 2^32', () => {
    assert.match(hotp(RFC_SHA1_SEED, Number.MAX_SAFE_INTEGER, 6, 'SHA1'), /^\d{6}$/);
    assert.throws(() => hotp(RFC_SHA1_SEED, -1, 6, 'SHA1'), /zero or more/);
  });
});

describe('TOTP (RFC 6238 Appendix B)', () => {
  const rows: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [seconds, sha1Code, sha256Code, sha512Code] of rows) {
    it(`matches every algorithm at T=${seconds}`, () => {
      const timeMs = seconds * 1000;
      assert.equal(totp(RFC_SHA1_SEED, timeMs, { period: 30, digits: 8, algorithm: 'SHA1' }), sha1Code);
      assert.equal(totp(RFC_SHA256_SEED, timeMs, { period: 30, digits: 8, algorithm: 'SHA256' }), sha256Code);
      assert.equal(totp(RFC_SHA512_SEED, timeMs, { period: 30, digits: 8, algorithm: 'SHA512' }), sha512Code);
    });
  }

  it('counts down the seconds left in the period', () => {
    assert.equal(secondsRemaining(30, 0), 30);
    assert.equal(secondsRemaining(30, 59_999), 1);
    assert.equal(secondsRemaining(60, 61_000), 59);
  });
});

describe('Steam Guard', () => {
  // Vectors from ValvePython/steam tests/test_guard.py (test_generate_twofactor_code_for_time):
  // https://raw.githubusercontent.com/ValvePython/steam/master/tests/test_guard.py
  const secret = ascii('superdupersecret');
  it('matches the ValvePython/steam published codes', () => {
    assert.equal(steamGuard(secret, 3000030 * 1000), 'YRGQJ');
    assert.equal(steamGuard(secret, 3000029 * 1000), '94R9D');
  });

  it('is what generateCode returns for a steam account', () => {
    const params: OtpParams = { type: 'steam', secret: base32Encode(secret), algorithm: 'SHA1', digits: 5, period: 30, counter: 0 };
    assert.equal(generateCode(params, 3000030 * 1000), 'YRGQJ');
  });
});

describe('generateCode and validateOtpParams', () => {
  const base: OtpParams = { type: 'totp', secret: RFC_SHA1_SEED_BASE32, algorithm: 'SHA1', digits: 8, period: 30, counter: 0 };

  it('generates TOTP from the base32 secret and HOTP from the counter', () => {
    assert.equal(generateCode(base, 59_000), '94287082');
    assert.equal(generateCode({ ...base, type: 'hotp', digits: 6, counter: 9 }, 0), '520489');
  });

  it('rejects bad digits, period, counter and algorithm', () => {
    assert.throws(() => validateOtpParams({ ...base, digits: 5 }), /6 to 8 digits/);
    assert.throws(() => validateOtpParams({ ...base, digits: 9 }), /6 to 8 digits/);
    assert.throws(() => validateOtpParams({ ...base, period: 0 }), /period/);
    assert.throws(() => validateOtpParams({ ...base, period: 1.5 }), /period/);
    assert.throws(() => validateOtpParams({ ...base, counter: -1 }), /counter/);
    assert.throws(() => validateOtpParams({ ...base, algorithm: 'MD5' as never }), /not supported/);
    assert.throws(() => validateOtpParams({ ...base, secret: '' }), /empty/);
  });

  it('allows five-character steam codes', () => {
    assert.doesNotThrow(() => validateOtpParams({ ...base, type: 'steam', digits: 5 }));
  });
});

describe('otpauth URIs', () => {
  it('reads a full TOTP link with percent-encoded issuer and label', () => {
    const account = parseOtpAuthUri(
      'otpauth://totp/ACME%20Co%3Ajohn.doe%40email.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60',
    );
    assert.equal(account.issuer, 'ACME Co');
    assert.equal(account.label, 'john.doe@email.com');
    assert.equal(account.type, 'totp');
    assert.equal(account.secret, 'HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ');
    assert.equal(account.algorithm, 'SHA256');
    assert.equal(account.digits, 8);
    assert.equal(account.period, 60);
  });

  it('uses defaults and an empty issuer when nothing says otherwise', () => {
    const account = parseOtpAuthUri('otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP');
    assert.deepEqual(
      { issuer: account.issuer, label: account.label, algorithm: account.algorithm, digits: account.digits, period: account.period },
      { issuer: '', label: 'alice', algorithm: 'SHA1', digits: 6, period: 30 },
    );
  });

  it('takes the issuer from the label prefix, with a space after the colon', () => {
    const account = parseOtpAuthUri('otpauth://totp/Example:%20alice@example.com?secret=JBSWY3DPEHPK3PXP');
    assert.equal(account.issuer, 'Example');
    assert.equal(account.label, 'alice@example.com');
  });

  it('prefers the issuer parameter over the label prefix', () => {
    const account = parseOtpAuthUri('otpauth://totp/Old:alice?secret=JBSWY3DPEHPK3PXP&issuer=New');
    assert.equal(account.issuer, 'New');
    assert.equal(account.label, 'alice');
  });

  it('accepts upper-case scheme and type, lower-case secret, padding, spaces and +', () => {
    const account = parseOtpAuthUri('OTPAUTH://TOTP/x?secret=jbsw+y3dp%20ehpk3pxp%3D%3D%3D&issuer=Big+Bank');
    assert.equal(account.secret, 'JBSWY3DPEHPK3PXP');
    assert.equal(account.issuer, 'Big Bank');
  });

  it('reads the HOTP counter and requires it', () => {
    assert.equal(parseOtpAuthUri('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=42').counter, 42);
    assert.throws(() => parseOtpAuthUri('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP'), /no counter/);
  });

  it('reads Steam from encoder=steam and from the steam type', () => {
    const fromEncoder = parseOtpAuthUri('otpauth://totp/Steam:gaben?secret=JBSWY3DPEHPK3PXP&issuer=Steam&encoder=steam');
    const fromType = parseOtpAuthUri('otpauth://steam/Steam:gaben?secret=JBSWY3DPEHPK3PXP');
    for (const account of [fromEncoder, fromType]) {
      assert.equal(account.type, 'steam');
      assert.equal(account.digits, 5);
      assert.equal(account.issuer, 'Steam');
    }
  });

  it('rejects unusable links with messages that say what to do', () => {
    assert.throws(() => parseOtpAuthUri('https://example.com'), /otpauth:\/\/totp/);
    assert.throws(() => parseOtpAuthUri('otpauth://totp/x?issuer=A'), /no secret/);
    assert.throws(() => parseOtpAuthUri('otpauth://totp/x?secret=JBSW1'), /not valid base32/);
    assert.throws(() => parseOtpAuthUri('otpauth://yubi/x?secret=JBSWY3DPEHPK3PXP'), /not supported/);
    assert.throws(() => parseOtpAuthUri('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=10'), /6 to 8 digits/);
    assert.throws(() => parseOtpAuthUri('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=six'), /not a whole number/);
    assert.throws(() => parseOtpAuthUri('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5'), /not supported/);
    assert.throws(() => parseOtpAuthUri('otpauth://totp/%E0%A4?secret=JBSWY3DPEHPK3PXP'), /%-encoding/);
  });

  it('round-trips formatted links', () => {
    const accounts: OtpAccount[] = [
      { issuer: 'ACME Co', label: 'john@example.com', type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA512', digits: 8, period: 60, counter: 0 },
      { issuer: '', label: 'plain', type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, counter: 0 },
      { issuer: '', label: 'a:b', type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, counter: 0 },
      { issuer: 'R&D + Ops', label: 'x:y z', type: 'hotp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 7, period: 30, counter: 2 ** 40 },
      { issuer: 'Steam', label: 'gaben', type: 'steam', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 5, period: 30, counter: 0 },
    ];
    for (const account of accounts) assert.deepEqual(parseOtpAuthUri(formatOtpAuthUri(account)), account);
  });
});

/** Minimal protobuf writer for building test exports. BigInt keeps negative int32s as 10-byte varints. */
function varint(value: number | bigint): number[] {
  let rest = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  do {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    out.push(rest === 0n ? byte : byte | 0x80);
  } while (rest !== 0n);
  return out;
}
const varintField = (field: number, value: number | bigint) => [...varint(field << 3), ...varint(value)];
const bytesField = (field: number, bytes: Uint8Array | number[]) => [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
const textField = (field: number, text: string) => bytesField(field, utf8Encode(text));

interface TestOtp {
  secret: string;
  name: string;
  issuer: string;
  algorithm: number;
  digits: number;
  type: number;
  counter?: number;
}

function encodeOtp(otp: TestOtp): number[] {
  return [
    ...bytesField(1, ascii(otp.secret)),
    ...textField(2, otp.name),
    ...textField(3, otp.issuer),
    ...varintField(4, otp.algorithm),
    ...varintField(5, otp.digits),
    ...varintField(6, otp.type),
    ...(otp.counter === undefined ? [] : varintField(7, otp.counter)),
  ];
}

function encodePayload(otps: TestOtp[], batch: { id: number; index: number; size: number }, extra: number[] = []): Uint8Array {
  return Uint8Array.from([
    ...otps.flatMap((otp) => bytesField(1, encodeOtp(otp))),
    ...varintField(2, 1),
    ...varintField(3, batch.size),
    ...varintField(4, batch.index),
    ...varintField(5, batch.id),
    ...extra,
  ]);
}

const migrationUri = (payload: Uint8Array) => `otpauth-migration://offline?data=${encodeURIComponent(toBase64(payload))}`;

describe('Google Authenticator export', () => {
  const github: TestOtp = { secret: 'hello-github-0001', name: 'GitHub:octocat', issuer: 'GitHub', algorithm: 1, digits: 1, type: 2 };
  const bank: TestOtp = { secret: 'bank-secret-2', name: 'alice', issuer: 'Bank', algorithm: 2, digits: 2, type: 0 };
  const counterBased: TestOtp = { secret: 'hotp-secret', name: 'vpn', issuer: '', algorithm: 0, digits: 0, type: 1, counter: 7 };
  const legacy: TestOtp = { secret: 'md5-secret', name: 'Old:legacy', issuer: 'Old', algorithm: 4, digits: 1, type: 2 };
  // Unknown fields of every wire type must be skipped: varint, fixed64, length-delimited, fixed32.
  const unknownFields = [...varintField(15, 3), ...varint((16 << 3) | 1), 1, 2, 3, 4, 5, 6, 7, 8, ...bytesField(17, [9, 9]), ...varint((18 << 3) | 5), 1, 2, 3, 4];

  it('imports TOTP and HOTP accounts and skips MD5 ones', () => {
    const parsed = parseMigrationUri(migrationUri(encodePayload([github, bank, counterBased, legacy], { id: -123456, index: 0, size: 1 }, unknownFields)));
    assert.deepEqual(parsed.batch, { id: -123456, index: 0, size: 1 });
    assert.equal(parsed.accounts.length, 3);
    const [first, second, third] = parsed.accounts;
    assert.deepEqual(first, {
      issuer: 'GitHub', label: 'octocat', type: 'totp', secret: base32Encode(ascii(github.secret)), algorithm: 'SHA1', digits: 6, period: 30, counter: 0,
    });
    assert.deepEqual(
      { issuer: second?.issuer, label: second?.label, type: second?.type, algorithm: second?.algorithm, digits: second?.digits },
      { issuer: 'Bank', label: 'alice', type: 'totp', algorithm: 'SHA256', digits: 8 },
    );
    assert.deepEqual({ issuer: third?.issuer, label: third?.label, type: third?.type, counter: third?.counter }, { issuer: '', label: 'vpn', type: 'hotp', counter: 7 });
    assert.deepEqual(parsed.skipped.map((entry) => entry.name), ['Old (legacy)']);
    assert.match(parsed.skipped[0]?.reason ?? '', /MD5/);
  });

  it('accepts an unencoded + in the data', () => {
    const payload = encodePayload([github], { id: 1, index: 0, size: 1 });
    const raw = `otpauth-migration://offline?data=${toBase64(payload)}`;
    assert.equal(parseMigrationUri(raw).accounts.length, 1);
  });

  it('combines batches out of order, ignores repeat scans and reports missing ones', () => {
    const scan = (otp: TestOtp, index: number) => parseMigrationUri(migrationUri(encodePayload([otp], { id: 77, index, size: 4 })));
    const scans: MigrationBatch[] = [scan(bank, 2), scan(github, 0), scan(bank, 2), scan(counterBased, 3)];
    const combined = combineMigrationBatches(scans);
    assert.deepEqual(combined.accounts.map((account) => account.issuer || account.label), ['GitHub', 'Bank', 'vpn']);
    assert.deepEqual(combined.missingBatches, [1]);
    assert.deepEqual(combined.skipped, []);
  });

  it('refuses codes from two different exports', () => {
    const a = parseMigrationUri(migrationUri(encodePayload([github], { id: 1, index: 0, size: 2 })));
    const b = parseMigrationUri(migrationUri(encodePayload([bank], { id: 2, index: 1, size: 2 })));
    assert.throws(() => combineMigrationBatches([a, b]), /two different exports/);
  });

  it('rejects truncated or damaged payloads', () => {
    const payload = encodePayload([github, bank], { id: 5, index: 0, size: 1 });
    const firstAccountLength = bytesField(1, encodeOtp(github)).length;
    // Every prefix that ends inside the first account must fail; later cuts can land on a field boundary.
    for (let kept = 1; kept < firstAccountLength; kept++) {
      assert.throws(() => parseMigrationUri(migrationUri(payload.subarray(0, kept))), /cut off/, `kept ${kept} bytes`);
    }
    assert.throws(() => parseMigrationUri(migrationUri(Uint8Array.from(new Array(12).fill(0xff)))), /cut off/);
    const hugeLength = Uint8Array.from([...varint((1 << 3) | 2), ...varint(2 ** 40)]);
    assert.throws(() => parseMigrationUri(migrationUri(hugeLength)), /cut off/);
    assert.throws(() => parseMigrationUri(migrationUri(encodePayload([], { id: 1, index: 3, size: 2 }))), /cut off/);
  });

  it('rejects links that are not exports', () => {
    assert.throws(() => parseMigrationUri('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP'), /not a Google Authenticator export/);
    assert.throws(() => parseMigrationUri('otpauth-migration://offline?foo=1'), /no data/);
  });
});
