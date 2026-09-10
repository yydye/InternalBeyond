'use strict';

/*
 * Internal Beyond · minimal PE version-resource reader (U3)
 *
 * WHY THIS EXISTS
 *   U-D6 item 5 makes "PE ProductVersion/FileVersion mismatch" a hard failure
 *   that must never be retried down the fallback route. The downloaded installer
 *   is an EXE, and the only version it declares about itself in a form Windows
 *   itself uses is its version resource. Checking it is a second, independent
 *   gate next to SHA-256:
 *
 *     sha256   the bytes are the bytes the manifest described
 *     PE       the FILE is the version the manifest announced
 *
 *   Together they catch the one case a hash alone cannot: a release where the
 *   manifest and the payload agree with each other but both describe the wrong
 *   version (a stale exe re-published under a bumped VERSION, or an ISCC run
 *   that forgot the /DAppVersion define). See RELEASE.md §5 for the build-side
 *   gate that makes that impossible to publish in the first place.
 *
 * WHAT IT IS NOT
 *   Not a signature check, not an authenticity check, and not a general PE
 *   parser. It reads exactly one thing — the RT_VERSION resource — and reports
 *   "I could not find it" honestly rather than guessing. The installer is NOT
 *   code signed (U-series, RELEASE.md §7); nothing here changes that.
 *
 * HOW IT READS
 *   Bounded, positioned reads (fs.readSync at explicit offsets) instead of
 *   slurping the file: the payload is ~48 MB and the caller may be checking a
 *   file it has every reason to distrust, so nothing is read that is not part of
 *   the headers or the resource directory. Every offset is bounds-checked
 *   against the file length and against the buffer actually read.
 *
 * Zero dependencies. Never throws: an unreadable, truncated or hostile file is
 * a failed check, reported as { ok: false, why }.
 */

const fs = require('fs');

/* ── Frozen constants ─────────────────────────────────────────────────────── */

const RT_VERSION = 16;          /* Win32 resource type: VERSION */
const VS_FIXEDFILEINFO_SIG = 0xFEEF04BD;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;

/* The resource section holds icons too, but never anything near this. A cap
   keeps a crafted file from making us allocate an arbitrary amount. */
const MAX_RESOURCE_SECTION_BYTES = 16 * 1024 * 1024;
/* A version resource is a few KB at most. */
const MAX_VERSION_BLOB_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

/* ── Small helpers ────────────────────────────────────────────────────────── */

function align4(n) { return (n + 3) & ~3; }

function posInt(v, max) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

/* Read exactly `length` bytes at `offset`. Returns null instead of throwing when
   the file is shorter than promised. */
function readAt(fd, offset, length, fileSize) {
  if (!posInt(offset, fileSize) || !posInt(length, fileSize) || length === 0) return null;
  if (offset + length > fileSize) return null;
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    let n = 0;
    try { n = fs.readSync(fd, buf, got, length - got, offset + got); } catch (e) { return null; }
    if (!n) return null;
    got += n;
  }
  return buf;
}

/* A NUL-terminated UTF-16LE string inside `buf`, starting at `offset`. */
function readUtf16z(buf, offset, limit) {
  const end = Math.min(limit, buf.length);
  let p = offset;
  let out = '';
  while (p + 1 < end) {
    const code = buf.readUInt16LE(p);
    if (code === 0) return { value: out, end: p + 2 };
    out += String.fromCharCode(code);
    p += 2;
    if (out.length > 512) return null; /* a "key" this long is not a key */
  }
  return null;
}

function formatFixedVersion(ms, ls) {
  return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
}

/* ── Resource directory walking ───────────────────────────────────────────── */

/*
 * Walk `IMAGE_RESOURCE_DIRECTORY` levels looking for the RT_VERSION leaf, then
 * return the IMAGE_RESOURCE_DATA_ENTRY it points at.
 *
 * `sec` is the whole resource section mapped at RVA `secRva`, with `sec` byte 0
 * == RVA secRva.
 */
function findVersionDataEntry(sec, secRva) {
  if (!sec || sec.length < 16) return { ok: false, why: 'resource section is too small to hold a directory' };

  const dirAt = function (rel) {
    if (!posInt(rel, sec.length) || rel + 16 > sec.length) return null;
    return {
      named: sec.readUInt16LE(rel + 12),
      ids: sec.readUInt16LE(rel + 14),
      first: rel + 16
    };
  };

  /* One level: find `wantId` (or the first entry when wantId is null) among the
     id entries — named entries are skipped, a version resource is never named. */
  const findEntry = function (dirRel, wantId, depth) {
    const dir = dirAt(dirRel);
    if (!dir) return { ok: false, why: 'resource directory level ' + depth + ' is out of range' };
    const count = dir.named + dir.ids;
    if (count > 4096) return { ok: false, why: 'implausible resource directory entry count (' + count + ')' };
    for (let i = 0; i < dir.ids; i++) {
      const entryRel = dir.first + (dir.named + i) * 8;
      if (entryRel + 8 > sec.length) return { ok: false, why: 'resource directory entry is out of range' };
      const id = sec.readUInt32LE(entryRel);
      const off = sec.readUInt32LE(entryRel + 4);
      if (wantId === null || id === wantId) return { ok: true, id: id, off: off };
    }
    return { ok: false, why: 'resource type ' + (wantId === null ? '(any)' : wantId) + ' is not present' };
  };

  const type = findEntry(0, RT_VERSION, 1);
  if (!type.ok) return { ok: false, why: type.why };
  if (!(type.off & 0x80000000)) return { ok: false, why: 'RT_VERSION entry is not a subdirectory' };

  const nameLvl = findEntry(type.off & 0x7fffffff, null, 2);
  if (!nameLvl.ok) return { ok: false, why: nameLvl.why };
  if (!(nameLvl.off & 0x80000000)) return { ok: false, why: 'RT_VERSION name entry is not a subdirectory' };

  const langLvl = findEntry(nameLvl.off & 0x7fffffff, null, 3);
  if (!langLvl.ok) return { ok: false, why: langLvl.why };
  if (langLvl.off & 0x80000000) return { ok: false, why: 'RT_VERSION language entry is another subdirectory' };

  const dataRel = langLvl.off;
  if (dataRel + 16 > sec.length) return { ok: false, why: 'image resource data entry is out of range' };
  return {
    ok: true,
    rva: sec.readUInt32LE(dataRel),
    size: sec.readUInt32LE(dataRel + 4),
    secRva: secRva
  };
}

/* ── VS_VERSIONINFO parsing ───────────────────────────────────────────────── */

/*
 * Parse one VS_VERSIONINFO block.
 * Returns { ok, why, fixed:{fileVersion,productVersion}, strings:{...} }.
 */
function parseVersionInfo(buf) {
  const fail = function (why) { return { ok: false, why: why, fixed: null, strings: {} }; };
  if (!buf || buf.length < 8) return fail('version resource is too small');

  const total = buf.readUInt16LE(0);
  const valueLength = buf.readUInt16LE(2);
  const type = buf.readUInt16LE(4);
  if (total < 8 || total > buf.length) return fail('VS_VERSIONINFO length ' + total + ' is out of range');

  const key = readUtf16z(buf, 6, total);
  if (!key) return fail('VS_VERSIONINFO key is not terminated');
  if (key.value !== 'VS_VERSION_INFO') return fail('unexpected VS_VERSIONINFO key ' + JSON.stringify(key.value));

  const fixedAt = align4(key.end);
  let fixed = null;
  if (valueLength >= 52) {
    if (fixedAt + 52 > total) return fail('VS_FIXEDFILEINFO is out of range');
    if (buf.readUInt32LE(fixedAt) !== VS_FIXEDFILEINFO_SIG) {
      return fail('VS_FIXEDFILEINFO signature is missing');
    }
    fixed = {
      fileVersion: formatFixedVersion(buf.readUInt32LE(fixedAt + 8), buf.readUInt32LE(fixedAt + 12)),
      productVersion: formatFixedVersion(buf.readUInt32LE(fixedAt + 16), buf.readUInt32LE(fixedAt + 20))
    };
  }

  /* Children start after the fixed info, aligned to 4. */
  let p = align4(fixedAt + valueLength);
  const strings = {};

  while (p + 6 <= total) {
    const childLength = buf.readUInt16LE(p);
    if (childLength === 0) break;               /* padding at the end */
    if (childLength < 6 || p + childLength > total) {
      return fail('a VS_VERSIONINFO child block declares length ' + childLength + ' at ' + p);
    }
    const childValueLength = buf.readUInt16LE(p + 2);
    const childKey = readUtf16z(buf, p + 6, p + childLength);
    if (!childKey) return fail('VS_VERSIONINFO child key is not terminated');

    if (childKey.value === 'StringFileInfo') {
      /* StringFileInfo → StringTable(s) → String(s) */
      let t = align4(childKey.end);
      while (t + 6 <= p + childLength) {
        const tableLength = buf.readUInt16LE(t);
        if (tableLength === 0) break;
        if (tableLength < 6 || t + tableLength > p + childLength) {
          return fail('a StringTable declares length ' + tableLength);
        }
        const tableKey = readUtf16z(buf, t + 6, t + tableLength);
        if (!tableKey) return fail('StringTable key is not terminated');
        let s = align4(tableKey.end);
        while (s + 6 <= t + tableLength) {
          const strLength = buf.readUInt16LE(s);
          if (strLength === 0) break;
          if (strLength < 6 || s + strLength > t + tableLength) {
            return fail('a version string declares length ' + strLength);
          }
          const strValueLength = buf.readUInt16LE(s + 2);   /* in UTF-16 code units */
          const strKey = readUtf16z(buf, s + 6, s + strLength);
          if (!strKey) return fail('a version string key is not terminated');
          const valueAt = align4(strKey.end);
          const valueBytes = strValueLength * 2;
          if (valueAt + valueBytes > s + strLength) {
            return fail('version string ' + JSON.stringify(strKey.value) + ' value is out of range');
          }
          let value = buf.toString('utf16le', valueAt, valueAt + valueBytes);
          /* The declared length includes the terminator. */
          value = value.replace(/\u0000+$/, '').trim();
          if (!(strKey.value in strings)) strings[strKey.value] = value;
          s = align4(s + strLength);
        }
        t = align4(t + tableLength);
      }
    }
    p = align4(p + childLength);
  }

  if (!fixed && Object.keys(strings).length === 0) {
    return fail('the version resource carries neither fixed info nor string info');
  }
  return { ok: true, why: null, fixed: fixed, strings: strings, type: type };
}

/* ── The reader ───────────────────────────────────────────────────────────── */

/*
 * Read the version resource of `file`.
 *
 * Returns
 *   {
 *     ok, why,
 *     productVersion      StringFileInfo\...\ProductVersion, trimmed, or null
 *     fileVersion         StringFileInfo\...\FileVersion, trimmed, or null
 *     productVersionFixed 'a.b.c.d' from VS_FIXEDFILEINFO, or null
 *     fileVersionFixed    'a.b.c.d' from VS_FIXEDFILEINFO, or null
 *     strings             every StringFileInfo entry found
 *   }
 *
 * Never throws.
 */
function readPeVersion(file) {
  const empty = {
    ok: false, why: null, productVersion: null, fileVersion: null,
    productVersionFixed: null, fileVersionFixed: null, strings: {}
  };
  const fail = function (why) { return Object.assign({}, empty, { why: why }); };

  const target = String(file == null ? '' : file);
  if (!target) return fail('no file given');

  let fd = null;
  let size = 0;
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return fail('not a file: ' + target);
    size = st.size;
    fd = fs.openSync(target, 'r');
  } catch (e) {
    return fail('cannot open the file: ' + String((e && e.code) || e));
  }

  try {
    if (size < 64) return fail('too small to be a PE image (' + size + ' bytes)');

    const dos = readAt(fd, 0, 64, size);
    if (!dos || dos.readUInt16LE(0) !== 0x5a4d) return fail('missing the MZ signature');

    const peAt = dos.readUInt32LE(0x3c);
    if (!posInt(peAt, size) || peAt + 24 > size) return fail('e_lfanew points outside the file');

    const pe = readAt(fd, peAt, 24, size);
    if (!pe || pe.readUInt32LE(0) !== 0x00004550) return fail('missing the PE signature');

    const numberOfSections = pe.readUInt16LE(6);
    const optionalSize = pe.readUInt16LE(20);
    if (numberOfSections === 0) return fail('the image declares no sections');
    if (numberOfSections > 96) return fail('implausible section count (' + numberOfSections + ')');
    if (optionalSize < 96 || optionalSize > MAX_HEADER_BYTES) return fail('implausible optional header size (' + optionalSize + ')');

    const optionalAt = peAt + 24;
    const optional = readAt(fd, optionalAt, optionalSize, size);
    if (!optional) return fail('the optional header is out of range');
    const magic = optional.readUInt16LE(0);
    if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) return fail('unknown optional header magic 0x' + magic.toString(16));

    const dirOffset = magic === PE32_PLUS_MAGIC ? 112 : 96;
    if (dirOffset + 8 * 3 > optional.length) return fail('the optional header has no data directories');
    const resourceRva = optional.readUInt32LE(dirOffset + 8 * 2);
    const resourceSize = optional.readUInt32LE(dirOffset + 8 * 2 + 4);
    /* An RVA is a VIRTUAL address: it legitimately points past EOF (the image is
       mapped in pages, the file is not padded to match), so it is NOT checked
       against the file size here — rvaToOffset() below does that, and is the
       only place a virtual address becomes a file offset. */
    if (resourceRva === 0) return fail('the image has no resource directory');

    const sectionsAt = optionalAt + optionalSize;
    const table = readAt(fd, sectionsAt, numberOfSections * 40, size);
    if (!table) return fail('the section table is out of range');

    const sections = [];
    for (let i = 0; i < numberOfSections; i++) {
      const at = i * 40;
      sections.push({
        virtualAddress: table.readUInt32LE(at + 12),
        virtualSize: table.readUInt32LE(at + 8),
        rawPointer: table.readUInt32LE(at + 20),
        rawSize: table.readUInt32LE(at + 16)
      });
    }

    const rvaToOffset = function (rva) {
      for (const s of sections) {
        const span = Math.max(s.virtualSize, s.rawSize);
        if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
          const delta = rva - s.virtualAddress;
          if (delta >= s.rawSize) return null;   /* in virtual space only */
          return s.rawPointer + delta;
        }
      }
      return null;
    };

    const resOffset = rvaToOffset(resourceRva);
    if (resOffset === null) return fail('the resource directory RVA is not backed by file data');

    const wantBytes = Math.min(Math.max(resourceSize, 4096), MAX_RESOURCE_SECTION_BYTES, size - resOffset);
    if (wantBytes < 16) return fail('the resource section is too small');
    const sec = readAt(fd, resOffset, wantBytes, size);
    if (!sec) return fail('the resource section could not be read');

    const found = findVersionDataEntry(sec, resourceRva);
    if (!found.ok) return fail(found.why);

    const blobSize = Math.min(found.size, MAX_VERSION_BLOB_BYTES);
    if (blobSize < 8) return fail('the version resource is empty');
    const blobOffset = rvaToOffset(found.rva);
    if (blobOffset === null) return fail('the version resource RVA is not backed by file data');
    const blob = readAt(fd, blobOffset, blobSize, size);
    if (!blob) return fail('the version resource could not be read');

    const parsed = parseVersionInfo(blob);
    if (!parsed.ok) return fail(parsed.why);

    const strings = parsed.strings || {};
    return {
      ok: true,
      why: null,
      productVersion: typeof strings.ProductVersion === 'string' ? strings.ProductVersion : null,
      fileVersion: typeof strings.FileVersion === 'string' ? strings.FileVersion : null,
      productVersionFixed: parsed.fixed ? parsed.fixed.productVersion : null,
      fileVersionFixed: parsed.fixed ? parsed.fixed.fileVersion : null,
      strings: strings
    };
  } catch (e) {
    return fail('the version resource could not be parsed: ' + String((e && e.message) || e));
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { } }
  }
}

/* ── The U3 gate ──────────────────────────────────────────────────────────── */

/*
 * Does this file declare the version the manifest announced?
 *
 * Both halves of the U-D6 gate are required:
 *   · the ProductVersion STRING must equal manifest.installer.productVersion
 *     (byte-for-byte after trimming) — this is the value the build reads back
 *     out of the exe with PowerShell and puts in the manifest, so the two must
 *     agree by construction
 *   · the FIXED file version must exist and its first three components must be
 *     the same version, which covers FileVersion
 *
 * The fixed version's fourth component is deliberately NOT compared: the Inno
 * script writes `VersionInfoVersion={#AppVersion}.0`, and pinning the client to
 * that trailing zero would turn a harmless build-script change into "every
 * update is refused".
 */
function matchesProductVersion(file, expected) {
  const want = String(expected == null ? '' : expected).trim();
  const read = readPeVersion(file);
  if (!read.ok) return { ok: false, why: read.why, read: read };
  if (!want) return { ok: false, why: 'no expected product version was given', read: read };

  if (!read.productVersion) {
    return { ok: false, why: 'the installer declares no ProductVersion string', read: read };
  }
  if (read.productVersion !== want) {
    return {
      ok: false,
      why: 'installer ProductVersion ' + JSON.stringify(read.productVersion) + ' is not ' + JSON.stringify(want),
      read: read
    };
  }
  if (!read.productVersionFixed) {
    return { ok: false, why: 'the installer has no VS_FIXEDFILEINFO product version', read: read };
  }
  const triple = read.productVersionFixed.split('.').slice(0, 3).join('.');
  if (triple !== want) {
    return {
      ok: false,
      why: 'installer fixed product version ' + read.productVersionFixed + ' is not ' + want + '.x',
      read: read
    };
  }
  if (!read.fileVersionFixed) {
    return { ok: false, why: 'the installer has no VS_FIXEDFILEINFO file version', read: read };
  }
  const fileTriple = read.fileVersionFixed.split('.').slice(0, 3).join('.');
  if (fileTriple !== want) {
    return {
      ok: false,
      why: 'installer FileVersion ' + read.fileVersionFixed + ' is not ' + want + '.x',
      read: read
    };
  }
  return { ok: true, why: null, read: read };
}

module.exports = {
  RT_VERSION: RT_VERSION,
  VS_FIXEDFILEINFO_SIG: VS_FIXEDFILEINFO_SIG,
  MAX_RESOURCE_SECTION_BYTES: MAX_RESOURCE_SECTION_BYTES,
  MAX_VERSION_BLOB_BYTES: MAX_VERSION_BLOB_BYTES,
  align4: align4,
  formatFixedVersion: formatFixedVersion,
  parseVersionInfo: parseVersionInfo,
  readPeVersion: readPeVersion,
  matchesProductVersion: matchesProductVersion
};
