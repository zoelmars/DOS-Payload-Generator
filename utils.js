/* ============================================================================
 * utils.js — Helper murni (tanpa DOM) untuk Text Repetition Generator
 *
 * Dimuat di tiga konteks:
 *   1. Main thread browser  → global `TRGGUtils`
 *   2. Unit test Node.js    → module.exports
 *   3. Di-serialize ke dalam Web Worker (lihat worker.js → createWorkerSource)
 *
 * Semua fungsi di sini sengaja dibuat "standalone" (tidak memanggil helper
 * lain di luar dirinya yang tidak ikut di-serialize) agar aman di-serialisasi
 * via Function.prototype.toString().
 * ========================================================================== */
;((root, factory) => {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(); // Node.js (unit test)
  } else {
    root.TRGGUtils = factory(); // Browser
  }
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Ukuran chunk yang dikirim antar konteks (karakter per chunk).
  const DEFAULT_CHUNK_SIZE = 1000000;
  // Budget karakter yang diproses per tick setTimeout(0).
  const TICK_CHAR_BUDGET_MULTIPLIER = 2;

  const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'];

  /**
   * Hitung total panjang output dalam karakter (UTF-16 units):
   *   textLength * count + sepLength * (count - 1)
   * Return Infinity jika hasil melebihi batas aman Number JS.
   */
  function computeTotalLength(textLength, count, sepLength) {
    if (!isFinite(textLength) || !isFinite(count) || !isFinite(sepLength)) {
      return Infinity;
    }
    if (count <= 0) return 0;
    const total = textLength * count + sepLength * (count - 1);
    if (!isFinite(total) || total > Number.MAX_SAFE_INTEGER) return Infinity;
    return total;
  }

  /**
   * Estimasi ukuran output (dalam karakter) dari input mentah.
   * Catatan: untuk emoji/karakter non-BMP, ukuran file UTF-8 aktual bisa
   * lebih besar dari estimasi karakter — ukuran aktual ditampilkan
   * setelah download (Blob.size).
   */
  function estimateBytes(text, count, separator) {
    return computeTotalLength(
      typeof text === 'string' ? text.length : 0,
      typeof count === 'number' && isFinite(count) ? count : 0,
      typeof separator === 'string' ? separator.length : 0
    );
  }

  /** Format angka byte → "B / KB / MB / GB" (basis 1000). */
  function formatBytes(bytes) {
    if (bytes === Infinity) return '\u221E'; // ∞
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '\u2014';
    if (bytes < 1000) return Math.round(bytes) + ' B';
    let value = bytes;
    for (let i = 0; i < SIZE_UNITS.length; i += 1) {
      value /= 1000;
      const rounded = Number(value.toFixed(1));
      if (rounded < 1000 || i === SIZE_UNITS.length - 1) {
        return rounded.toFixed(1) + ' ' + SIZE_UNITS[i];
      }
    }
    return value.toFixed(1) + ' PB'; // jaring pengaman (tidak terjangkau)
  }

  /** Format angka besar gaya Indonesia: 15 rb, 2.5 jt, 1.2 M. */
  function formatCount(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '\u2014';
    if (n < 10000) return String(Math.round(n));
    if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + ' rb';
    if (n < 1000000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + ' jt';
    return (n / 1000000000).toFixed(1).replace(/\.0$/, '') + ' M';
  }

  /**
   * Generator streaming hasil pengulangan dalam bentuk chunk.
   *
   * Desain memori (spec §3): piece TIDAK dimaterialisasi jadi array raksasa —
   * posisi piece dihitung dari index (genap → text, ganjil → separator), jadi
   * hanya ada satu chunk aktif (~chunkSize) di memori pada satu waktu.
   *
   * next() → { done: false, chunk, produced } per chunk, lalu
   *          { done: true,  produced } saat habis.
   */
  function createChunkGenerator(options) {
    const opts = options || {};
    const text = typeof opts.text === 'string' ? opts.text : null;
    const separator = typeof opts.separator === 'string' ? opts.separator : '';
    const count = opts.count;
    const chunkSize =
      typeof opts.chunkSize === 'number' && isFinite(opts.chunkSize) && opts.chunkSize > 0
        ? Math.floor(opts.chunkSize)
        : DEFAULT_CHUNK_SIZE;

    if (text === null) {
      throw new TypeError('options.text wajib berupa string.');
    }
    if (typeof count !== 'number' || !isFinite(count) || count < 0 || Math.floor(count) !== count) {
      throw new TypeError('options.count wajib integer >= 0.');
    }

    const totalPieces = count > 0 ? count * 2 - 1 : 0;
    let index = 0;
    let produced = 0;
    let parts = [];
    let partsLength = 0;
    let finished = false;

    function next() {
      if (finished) {
        return { done: true, produced: produced, chunk: '' };
      }
      while (index < totalPieces) {
        const piece = index % 2 === 1 ? separator : text;
        index += 1;
        parts.push(piece);
        partsLength += piece.length;
        if (partsLength >= chunkSize) {
          produced += partsLength;
          const chunk = parts.join('');
          parts = [];
          partsLength = 0;
          return { done: false, chunk: chunk, produced: produced };
        }
      }
      // Sisa terakhir (< chunkSize) — pastikan tetap terkirim sebelum done.
      produced += partsLength;
      const lastChunk = parts.join('');
      parts = [];
      partsLength = 0;
      finished = true;
      return { done: false, chunk: lastChunk, produced: produced, final: true };
    }

    return { next: next };
  }

  /**
   * Convenience: separator dari input teks — dukung escape literal
   * "\n" (baris baru), "\t" (tab), "\r" (carriage return).
   */
  function unescapeSeparator(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  }

  /**
   * Sanitasi nama file: trim, ganti karakter ilegal, dan pastikan
   * berakhiran ".txt" (spec §5).
   */
  function normalizeFilename(rawName, fallback) {
    const fb = typeof fallback === 'string' && fallback ? fallback : 'result.txt';
    let name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) name = fb;
    name = name.replace(/[\\/:*?"<>|]/g, '-'); // karakter ilegal nama file
    name = name.replace(/\s+/g, ' ');
    if (!/\.txt$/i.test(name)) name += '.txt';
    return name;
  }

  return {
    DEFAULT_CHUNK_SIZE,
    TICK_CHAR_BUDGET_MULTIPLIER,
    computeTotalLength,
    estimateBytes,
    formatBytes,
    formatCount,
    createChunkGenerator,
    unescapeSeparator,
    normalizeFilename
  };
});
