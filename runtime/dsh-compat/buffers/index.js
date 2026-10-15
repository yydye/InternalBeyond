'use strict';

/* Minimal BufferList surface used by DSH's pinned binary@0.3.0 dependency.
 * All storage and slicing uses Node's native Buffer implementation. */

function assertBuffers(values) {
  for (const value of values) {
    if (!Buffer.isBuffer(value)) throw new TypeError('Expected a Buffer');
  }
}

function normalizeOffset(value, length, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return number === Infinity ? length : fallback;
  const offset = Math.trunc(number);
  return offset < 0 ? Math.max(length + offset, 0) : Math.min(offset, length);
}

class Buffers {
  constructor(initial) {
    this.buffers = [];
    this.length = 0;
    if (initial != null) {
      if (!Array.isArray(initial)) throw new TypeError('Initial buffers must be an array');
      this.push(...initial);
    }
  }

  push(...values) {
    assertBuffers(values);
    for (const value of values) {
      this.buffers.push(value);
      this.length += value.length;
    }
    return this.length;
  }

  unshift(...values) {
    assertBuffers(values);
    for (let index = values.length - 1; index >= 0; index--) {
      this.buffers.unshift(values[index]);
      this.length += values[index].length;
    }
    return this.length;
  }

  views(start, end) {
    const from = normalizeOffset(start, this.length, 0);
    const to = normalizeOffset(end, this.length, this.length);
    const finalEnd = Math.max(from, to);
    if (from === finalEnd) return [];
    const views = [];
    let offset = 0;
    for (const buffer of this.buffers) {
      const bufferEnd = offset + buffer.length;
      if (bufferEnd > from && offset < finalEnd) {
        const localStart = Math.max(from - offset, 0);
        const localEnd = Math.min(finalEnd - offset, buffer.length);
        if (localEnd > localStart) views.push(buffer.subarray(localStart, localEnd));
      }
      offset = bufferEnd;
      if (offset >= finalEnd) break;
    }
    return views;
  }

  slice(start, end) {
    return Buffer.concat(this.views(start, end));
  }

  splice(start, deleteCount, ...inserted) {
    assertBuffers(inserted);
    const from = normalizeOffset(start, this.length, 0);
    const removeCount = deleteCount == null
      ? this.length - from
      : Math.max(0, Math.min(Math.trunc(Number(deleteCount) || 0), this.length - from));
    const removed = this.views(from, from + removeCount);
    const before = this.views(0, from);
    const after = this.views(from + removeCount, this.length);
    this.buffers = before.concat(inserted, after).filter(buffer => buffer.length > 0);
    this.length = this.buffers.reduce((total, buffer) => total + buffer.length, 0);
    return new Buffers(removed);
  }

  indexOf(needle, offset) {
    if (typeof needle === 'string') needle = Buffer.from(needle);
    if (!Buffer.isBuffer(needle)) throw new TypeError('Search value must be a Buffer or string');
    if (needle.length === 0) return 0;
    const from = normalizeOffset(offset, this.length, 0);
    return this.slice().indexOf(needle, from);
  }
}

module.exports = function createBuffers(initial) {
  return new Buffers(initial);
};
module.exports.Buffers = Buffers;
