'use strict';

/*
 * Synthetic PE images for the U3 tests (test helper, not a test itself).
 *
 * runtime/pe-version.js is a SECURITY gate: "the bytes are the bytes the manifest
 * described" (sha256) plus "the FILE is the version the manifest announced" (PE
 * version resource). Testing it only against whatever PE happens to sit on the
 * machine would leave its failure paths — a truncated resource, a missing
 * VS_FIXEDFILEINFO, an out-of-range RVA — completely unexercised.
 *
 * So this module builds a real, minimal, well-formed PE image (PE32 or PE32+,
 * one .rsrc section, one RT_VERSION resource) from scratch, and can deliberately
 * corrupt it in named ways. `runtime/node/node.exe` is used as the real-world
 * counterpart: it proves the reader copes with an image produced by a real
 * toolchain, and this proves it copes with everything else.
 *
 * No dependencies, no I/O beyond writing the bytes to a file.
 */

const fs = require('fs');
const path = require('path');

const PE32 = 0x10b;
const PE32_PLUS = 0x20b;
const VS_FIXEDFILEINFO_SIG = 0xFEEF04BD;

const DOS_HEADER_SIZE = 0x40;
const PE_AT = 0x80;
const SECTION_AT = 0x200;
const SECTION_RVA = 0x1000;
const SEC_ALIGN = 0x200;
const FILE_ALIGN = 0x200;

function align4(n) { return (n + 3) & ~3; }

/* A UTF-16LE, NUL-terminated key/value. */
function utf16z(s) { return Buffer.from(String(s) + '\u0000', 'utf16le'); }
function utf16(s) { return Buffer.from(String(s), 'utf16le'); }

/* One StringFileInfo string entry: length, valueLength (in UTF-16 units, incl.
   terminator), type=1, key, padding, value. */
function versionString(name, value) {
  const key = utf16z(name);
  const val = utf16z(value);
  const keyAt = 6;
  const valAt = align4(keyAt + key.length);
  const total = align4(valAt + val.length);
  const buf = Buffer.alloc(total);
  buf.writeUInt16LE(total, 0);
  buf.writeUInt16LE(val.length / 2, 2);
  buf.writeUInt16LE(1, 4);
  key.copy(buf, keyAt);
  val.copy(buf, valAt);
  return buf;
}

/* A container block: StringTable / StringFileInfo / VS_VERSIONINFO children. */
function container(name, children, fixedInfo) {
  const key = utf16z(name);
  const keyAt = 6;
  const valueAt = align4(keyAt + key.length);
  const head = Buffer.alloc(valueAt);
  head.writeUInt16LE(0, 0);                                 /* length, patched below */
  head.writeUInt16LE(fixedInfo ? 52 : 0, 2);
  head.writeUInt16LE(fixedInfo ? 0 : 1, 4);
  key.copy(head, keyAt);
  const parts = [head];
  if (fixedInfo) parts.push(fixedInfo);
  /* Every block this helper builds is 4-byte aligned by construction, so the
     children concatenate directly. */
  for (const child of children) parts.push(child);
  const body = Buffer.concat(parts);
  body.writeUInt16LE(body.length, 0);
  const padded = Buffer.alloc(align4(body.length));
  body.copy(padded, 0);
  padded.writeUInt16LE(body.length, 0);
  return padded;
}

function fixedFileInfo(fileVersion, productVersion) {
  const buf = Buffer.alloc(52);
  buf.writeUInt32LE(VS_FIXEDFILEINFO_SIG, 0);
  buf.writeUInt32LE(0x00010000, 4);                        /* struc version */
  const quad = function (v) {
    const p = String(v).split('.').map(function (n) { return Number(n) | 0; });
    while (p.length < 4) p.push(0);
    return [(p[0] << 16) >>> 0 | (p[1] & 0xffff), (p[2] << 16) >>> 0 | (p[3] & 0xffff)];
  };
  const fv = quad(fileVersion);
  const pv = quad(productVersion);
  buf.writeUInt32LE(fv[0], 8);
  buf.writeUInt32LE(fv[1], 12);
  buf.writeUInt32LE(pv[0], 16);
  buf.writeUInt32LE(pv[1], 20);
  return buf;
}

/*
 * Build a PE image whose RT_VERSION resource says what we tell it to.
 *
 * options:
 *   productVersion   string, default '1.2.0'
 *   fileVersion      string, default productVersion + '.0'
 *   productString    StringFileInfo ProductVersion, default productVersion
 *   fileString       StringFileInfo FileVersion, default productVersion
 *   arch             'pe32' | 'pe32+' (default 'pe32', which is what Inno Setup
 *                    actually produces)
 *   corrupt          one of the names below, or '' for a healthy image:
 *                      'no-mz'            DOS signature replaced
 *                      'no-pe'            PE signature replaced
 *                      'no-resource-dir'  data directory 2 zeroed
 *                      'no-rt-version'    the resource type is not 16
 *                      'bad-fixed-sig'    VS_FIXEDFILEINFO signature replaced
 *                      'truncated-blob'   the version resource size is a lie
 *                      'data-entry-oob'   the data entry points past the section
 *                      'no-sections'      NumberOfSections = 0
 *                      'empty'            8 bytes total
 */
function buildPe(options) {
  const o = options || {};
  const corrupt = String(o.corrupt || '');
  const productVersion = String(o.productVersion || '1.2.0');
  const fileVersion = String(o.fileVersion || (productVersion + '.0'));
  const productString = String(o.productString === undefined ? productVersion : o.productString);
  const fileString = String(o.fileString === undefined ? productVersion : o.fileString);
  const magic = o.arch === 'pe32+' ? PE32_PLUS : PE32;

  if (corrupt === 'empty') return Buffer.alloc(8);

  /* ── the resource section body ───────────────────────────────────────── */
  const stringTable = container('040904b0', [
    versionString('ProductVersion', productString),
    versionString('FileVersion', fileString)
  ]);
  const stringFileInfo = container('StringFileInfo', [stringTable]);
  const versionInfo = container('VS_VERSION_INFO',
    [stringFileInfo], fixedFileInfo(fileVersion, productVersion));

  const ROOT_AT = 0;
  const L2_AT = 0x18;
  const L3_AT = 0x30;
  const DATA_AT = 0x48;
  const BLOB_AT = 0x58;

  let section = Buffer.alloc(align4(BLOB_AT + versionInfo.length) + 64);
  const writeDir = function (at, namedCount, idCount) {
    section.writeUInt32LE(0, at);          /* characteristics */
    section.writeUInt32LE(0, at + 4);      /* timestamp */
    section.writeUInt16LE(0, at + 8);      /* major */
    section.writeUInt16LE(0, at + 10);     /* minor */
    section.writeUInt16LE(namedCount, at + 12);
    section.writeUInt16LE(idCount, at + 14);
  };
  writeDir(ROOT_AT, 0, 1);
  section.writeUInt32LE(corrupt === 'no-rt-version' ? 24 : 16, ROOT_AT + 16);   /* type id */
  section.writeUInt32LE((0x80000000 | L2_AT) >>> 0, ROOT_AT + 20);
  writeDir(L2_AT, 0, 1);
  section.writeUInt32LE(1, L2_AT + 16);
  section.writeUInt32LE((0x80000000 | L3_AT) >>> 0, L2_AT + 20);
  writeDir(L3_AT, 0, 1);
  section.writeUInt32LE(0x409, L3_AT + 16);
  section.writeUInt32LE(DATA_AT, L3_AT + 20);

  const blobRva = SECTION_RVA + BLOB_AT;
  section.writeUInt32LE(corrupt === 'data-entry-oob' ? SECTION_RVA + 0x4000 : blobRva, DATA_AT);
  section.writeUInt32LE(corrupt === 'truncated-blob' ? versionInfo.length + 4096 : versionInfo.length, DATA_AT + 4);
  section.writeUInt32LE(1200, DATA_AT + 8);
  if (corrupt === 'bad-fixed-sig') {
    /* VS_FIXEDFILEINFO starts 40 bytes into the blob (key 'VS_VERSION_INFO' is
       34 bytes from offset 6). */
    versionInfo.writeUInt32LE(0x00000000, 40);
  }
  versionInfo.copy(section, BLOB_AT);
  section = section.slice(0, align4(BLOB_AT + versionInfo.length));

  /* ── headers ─────────────────────────────────────────────────────────── */
  const optionalSize = magic === PE32_PLUS ? 240 : 224;
  const headers = Buffer.alloc(SECTION_AT);
  headers.writeUInt16LE(corrupt === 'no-mz' ? 0x0000 : 0x5a4d, 0);   /* MZ */
  headers.writeUInt32LE(PE_AT, 0x3c);                      /* e_lfanew */

  headers.writeUInt32LE(corrupt === 'no-pe' ? 0x0000454c : 0x00004550, PE_AT);
  const coff = PE_AT + 4;
  headers.writeUInt16LE(magic === PE32_PLUS ? 0x8664 : 0x014c, coff);           /* machine */
  headers.writeUInt16LE(corrupt === 'no-sections' ? 0 : 1, coff + 2);
  headers.writeUInt16LE(optionalSize, coff + 16);

  const opt = PE_AT + 24;
  headers.writeUInt16LE(magic, opt);
  const dirOffset = magic === PE32_PLUS ? 112 : 96;
  if (corrupt !== 'no-resource-dir') {
    headers.writeUInt32LE(SECTION_RVA, opt + dirOffset + 8 * 2);               /* resource RVA */
    headers.writeUInt32LE(section.length, opt + dirOffset + 8 * 2 + 4);
  }

  const secTable = PE_AT + 24 + optionalSize;
  headers.write('.rsrc', secTable, 8, 'ascii');
  headers.writeUInt32LE(section.length, secTable + 8);                       /* virtual size */
  headers.writeUInt32LE(SECTION_RVA, secTable + 12);                         /* virtual address */
  headers.writeUInt32LE(align4(section.length), secTable + 16);              /* raw size */
  headers.writeUInt32LE(SECTION_AT, secTable + 20);                          /* raw pointer */

  return Buffer.concat([headers, section]);
}

/* Write a built image to `dir/<name>` and return the path. */
function writePe(dir, name, options) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, buildPe(options));
  return file;
}

module.exports = {
  PE32: PE32,
  PE32_PLUS: PE32_PLUS,
  buildPe: buildPe,
  writePe: writePe,
  versionString: versionString,
  container: container,
  fixedFileInfo: fixedFileInfo,
  utf16z: utf16z,
  align4: align4
};
