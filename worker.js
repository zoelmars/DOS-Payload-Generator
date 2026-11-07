/* ============================================================================
 * worker.js — Logika Web Worker untuk Text Repetition Generator
 *
 * Kenapa file ini ada dan kenapa bentuknya begini?
 *
 * 1. Spec Plans.md §3 mewajibkan Web Worker agar UI tidak freeze.
 * 2. Membuat Worker dari `new Worker('worker.js')` GAGAL saat halaman dibuka
 *    via file:// (CORS). Solusinya: source worker dibuat sebagai Blob URL.
 * 3. Supaya tetap SATU sumber kode, seluruh body worker ditulis dalam satu
 *    fungsi `workerMain(self)` yang di-serialize via
 *    Function.prototype.toString() → dirakit jadi string source oleh
 *    `createWorkerSource()` → dijadikan Blob URL oleh app.js.
 *    File ini tetap di-include sebagai <script> biasa di index.html hanya
 *    untuk menyediakan `TRGGWorker.createWorkerSource()`.
 *
 * Protokol pesan:
 *   main → worker : { type: 'generate', text, count, separator, chunkSize? }
 *                   { type: 'cancel' }
 *   worker → main : { type: 'start' }
 *                   { type: 'progress', produced, chunk }
 *                   { type: 'complete', produced }
 *                   { type: 'cancelled', produced }
 *                   { type: 'error', message }
 * ========================================================================== */
;((root, factory) => {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./utils.js')); // Node.js (unit test)
  } else {
    root.TRGGWorker = factory(root.TRGGUtils); // Browser (utils.js dimuat duluan)
  }
})(typeof self !== 'undefined' ? self : this, (utils) => {
  'use strict';

  /**
   * Body worker — SATU fungsi utuh, tanpa DOM, tanpa closure ke luar scope.
   * Semua yang dibutuhkan masuk lewat parameter (`self` = WorkerGlobalScope,
   * `deps` = helper murni dari utils.js).
   *
   * Strategi anti-blocking DI DALAM worker: job besar dipecah per-tick
   * setTimeout(0) supaya event loop worker tetap hidup dan pesan 'cancel'
   * dari main thread bisa diproses di tengah-tengah proses.
   */
  function workerMain(self, deps) {
    'use strict';

    // Semua dependensi lewat satu object:
    //   - Di Node test   : `deps` terisi (utils.js module).
    //   - Di Blob worker : `deps` undefined → fallback ke global yang
    //     didefinisikan preamble createWorkerSource().
    const d = deps || {
      createChunkGenerator: createChunkGenerator,
      DEFAULT_CHUNK_SIZE: DEFAULT_CHUNK_SIZE,
      TICK_CHAR_BUDGET_MULTIPLIER: TICK_CHAR_BUDGET_MULTIPLIER
    };

    let job = null;

    function post(message) {
      self.postMessage(message);
    }

    function assertValidInput(text, count, separator) {
      if (typeof text !== 'string') {
        throw new Error('Teks tidak valid.');
      }
      if (typeof count !== 'number' || !isFinite(count) || count < 1 || Math.floor(count) !== count) {
        throw new Error('Jumlah pengulangan harus berupa integer >= 1.');
      }
      if (typeof separator !== 'string') {
        throw new Error('Separator tidak valid.');
      }
    }

    function startJob(data) {
      if (job) {
        post({ type: 'error', message: 'Masih ada proses yang berjalan.' });
        return;
      }
      try {
        assertValidInput(data.text, data.count, data.separator);
      } catch (err) {
        post({ type: 'error', message: err.message });
        return;
      }

      const chunkSize =
        typeof data.chunkSize === 'number' && data.chunkSize > 0
          ? Math.floor(data.chunkSize)
          : d.DEFAULT_CHUNK_SIZE;

      job = {
        gen: d.createChunkGenerator({
          text: data.text,
          count: data.count,
          separator: data.separator,
          chunkSize: chunkSize
        }),
        produced: 0,
        timer: null
      };
      post({ type: 'start' });
      tick();
    }

    function tick() {
      if (!job) return;
      const budget = d.DEFAULT_CHUNK_SIZE * d.TICK_CHAR_BUDGET_MULTIPLIER;
      let processed = 0;
      while (processed < budget) {
        const r = job.gen.next();
        if (r.done) {
          job = null;
          post({ type: 'complete', produced: r.produced });
          return;
        }
        job.produced = r.produced;
        processed += r.chunk.length;
        post({ type: 'progress', produced: r.produced, chunk: r.chunk });
      }
      // Yield ke event loop worker → pesan {type:'cancel'} bisa masuk.
      job.timer = setTimeout(tick, 0);
    }

    function cancelJob() {
      if (!job) return;
      if (job.timer) clearTimeout(job.timer);
      const produced = job.produced;
      job = null;
      post({ type: 'cancelled', produced: produced });
    }

    self.onmessage = function onmessage(event) {
      const data = event && event.data ? event.data : {};
      if (data.type === 'generate') {
        startJob(data);
      } else if (data.type === 'cancel') {
        cancelJob();
      } else {
        post({ type: 'error', message: 'Tipe pesan tidak dikenal: ' + String(data.type) });
      }
    };
  }

  /**
   * Rakit source code worker sebagai string:
   *   1. Konstanta (nilai diambil dari utils.js — satu sumber kebenaran).
   *   2. Helper murni `createChunkGenerator` (di-serialize via toString).
   *   3. `workerMain(self)` dijalankan.
   * Hasilnya diubah jadi Blob URL oleh app.js → new Worker(blobUrl).
   *
   * Catatan: pendekatan ini valid karena kita ship JS vanilla tanpa
   * minifier/transpiler yang bisa mengubah nama identifier.
   */
  function createWorkerSource() {
    return [
      '// Auto-generated oleh worker.js — Text Repetition Generator.',
      '"use strict";',
      'var DEFAULT_CHUNK_SIZE = ' + JSON.stringify(utils.DEFAULT_CHUNK_SIZE) + ';',
      'var TICK_CHAR_BUDGET_MULTIPLIER = ' + JSON.stringify(utils.TICK_CHAR_BUDGET_MULTIPLIER) + ';',
      'var createChunkGenerator = ' + utils.createChunkGenerator.toString() + ';',
      '(' + workerMain.toString() + ')(self);'
    ].join('\n');
  }

  return {
    workerMain: workerMain,
    createWorkerSource: createWorkerSource
  };
});
