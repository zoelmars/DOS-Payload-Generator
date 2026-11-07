/* ============================================================================
 * app.js — Controller UI (main thread) untuk Text Repetition Generator
 *
 * Tugas file ini HANYA urusan DOM/UI:
 *   - validasi input + estimated size real-time
 *   - memulai/membatalkan proses generate (via Web Worker, atau fallback
 *     chunking setTimeout jika Worker tidak tersedia)
 *   - merakit Blob → trigger download → revokeObjectURL
 *
 * Logika berat (string generation) ada di worker.js / utils.js.
 * Prinsip spec Plans.md §3: NOL rendering hasil ke DOM.
 * ========================================================================== */
;(function () {
  'use strict';

  const U = window.TRGGUtils;
  const W = window.TRGGWorker;

  if (!U || !W) {
    // Fail fast: modul inti gagal dimuat (cek urutan <script> di index.html).
    window.addEventListener('DOMContentLoaded', () => {
      const el = document.getElementById('status-message');
      if (el) {
        el.textContent = 'Gagal memuat modul inti (utils.js / worker.js).';
        el.classList.add('is-error');
      }
    });
    return;
  }

  // -------------------------------------------------------------- Konstanta
  const SOFT_LIMIT_CHARS = 50000000; // 50 juta karakter — soft-limit (spec §5)
  const DEFAULT_CHUNK_SIZE = U.DEFAULT_CHUNK_SIZE; // 1.000.000 char / chunk
  const FALLBACK_TICK_BUDGET = DEFAULT_CHUNK_SIZE * U.TICK_CHAR_BUDGET_MULTIPLIER;
  const DOWNLOAD_REVOKE_DELAY_MS = 10000; // jeda aman sebelum revokeObjectURL (spec §3)

  const STATUS_TEXT = {
    idle: 'idle',
    generating: 'generating...',
    completed: 'completed',
    cancelled: 'cancelled',
    error: 'error'
  };

  // ------------------------------------------------------------------ State
  const state = {
    phase: 'idle', // idle | generating | completed | cancelled | error
    worker: null, // instance Worker aktif
    workerUrl: null, // cache Blob URL worker
    gen: null, // generator fallback (mode tanpa Worker)
    timer: null, // timer tick fallback
    chunks: [], // akumulasi chunk hasil generate → bahan Blob
    received: 0, // karakter yang sudah diproduksi
    total: 0, // estimasi total karakter
    cancelRequested: false
  };

  const els = {};

  // ------------------------------------------------------------- DOM Helper
  function initDomRefs() {
    [
      'generator-form', 'text-input', 'count-input', 'separator-input',
      'filename-input', 'size-value', 'hint', 'progress-bar', 'progress-fill',
      'status-label', 'status-message', 'generate-btn', 'cancel-btn'
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) throw new Error('Elemen #' + id + ' tidak ditemukan di index.html');
      els[id] = el;
    });
  }

  // -------------------------------------------------------- UI: status/bar
  function setPhase(phase) {
    state.phase = phase;
    els['status-label'].dataset.status = phase;
    els['status-label'].textContent = STATUS_TEXT[phase] || phase;
    els['generate-btn'].disabled = phase === 'generating';
    els['cancel-btn'].disabled = phase !== 'generating';
    document.body.classList.toggle('is-generating', phase === 'generating');
    els['progress-bar'].setAttribute('aria-busy', phase === 'generating' ? 'true' : 'false');
  }

  function setProgress(received, total) {
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 100;
    els['progress-fill'].style.width = pct + '%';
    els['progress-bar'].setAttribute('aria-valuenow', String(pct));
    if (!state.cancelRequested) {
      els['status-message'].textContent =
        U.formatBytes(received) + ' / ' + U.formatBytes(total) + ' \u2022 ' + pct + '%';
    }
  }

  function setStatusMessage(text, isError) {
    els['status-message'].textContent = text;
    els['status-message'].classList.toggle('is-error', Boolean(isError));
  }

  // --------------------------------------------------------------- Validasi
  function readCount() {
    const n = els['count-input'].valueAsNumber; // NaN kalau kosong/invalid
    return Number.isFinite(n) ? n : NaN;
  }

  function getValidationError(text, count, total) {
    if (!text) return 'Teks masih kosong \u2014 isi dulu teks yang mau diulang.';
    if (Number.isNaN(count)) return 'Jumlah pengulangan wajib diisi.';
    if (!Number.isInteger(count) || count < 1) return 'Jumlah pengulangan harus integer > 0.';
    if (!Number.isFinite(total) || total > SOFT_LIMIT_CHARS) {
      return 'Soft-limit ' + U.formatCount(SOFT_LIMIT_CHARS) + ' karakter terlampaui \u2014 turunkan input agar browser tidak kehabisan memori.';
    }
    return null;
  }

  /** Update estimated size + hint secara real-time. Return pesan error/null. */
  function updateEstimate() {
    const text = els['text-input'].value;
    const count = readCount();
    const separator = U.unescapeSeparator(els['separator-input'].value);
    const total = U.estimateBytes(text, Number.isNaN(count) ? 0 : count, separator);
    const err = getValidationError(text, count, total);

    els['size-value'].textContent = !text || Number.isNaN(count) ? '\u2014' : U.formatBytes(total);
    els['hint'].hidden = !err;
    els['hint'].textContent = err || '';
    els['generate-btn'].disabled = state.phase === 'generating' || Boolean(err);
    return err;
  }

  // ---------------------------------------------------------- Generate flow
  function generateAndDownload(event) {
    if (event) event.preventDefault();
    if (state.phase === 'generating') return;

    const err = updateEstimate();
    if (err) {
      setPhase('error');
      setStatusMessage(err, true);
      return;
    }

    const text = els['text-input'].value;
    const count = readCount();
    const separator = U.unescapeSeparator(els['separator-input'].value);
    const filename = U.normalizeFilename(els['filename-input'].value);
    els['filename-input'].value = filename; // feedback: tampilkan nama final

    state.chunks = [];
    state.received = 0;
    state.total = U.estimateBytes(text, count, separator);
    state.cancelRequested = false;

    setPhase('generating');
    setProgress(0, state.total);

    if (startWorkerJob(text, count, separator)) return;
    startFallbackJob(text, count, separator); // fallback tanpa Worker
  }

  // ------------------------------------------------------------ Web Worker
  function ensureWorkerUrl() {
    if (state.workerUrl) return state.workerUrl;
    if (typeof Worker === 'undefined') return null;
    try {
      const source = W.createWorkerSource();
      state.workerUrl = URL.createObjectURL(
        new Blob([source], { type: 'application/javascript' })
      );
    } catch (err) {
      state.workerUrl = null;
    }
    return state.workerUrl;
  }

  function startWorkerJob(text, count, separator) {
    const url = ensureWorkerUrl();
    if (!url) return false;

    let worker;
    try {
      worker = new Worker(url);
    } catch (err) {
      return false;
    }

    state.worker = worker;
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (errEvent) => {
      cleanupJob();
      setPhase('error');
      setStatusMessage(
        'Worker error: ' + (errEvent && errEvent.message ? errEvent.message : 'tidak diketahui'),
        true
      );
    };
    worker.postMessage({
      type: 'generate',
      text: text,
      count: count,
      separator: separator,
      chunkSize: DEFAULT_CHUNK_SIZE
    });
    return true;
  }

  // ------------------------------------------------- Assemble & download
  function assembleAndDownload(chunks, produced) {
    let url = null;
    try {
      // NOL rendering ke DOM (spec §3): langsung Blob → a[download].
      const blob = new Blob(chunks, { type: 'text/plain;charset=utf-8' });
      url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = U.normalizeFilename(els['filename-input'].value);
      document.body.appendChild(a);
      a.click();
      a.remove();

      // Bebaskan memori: revoke URL setelah delay agar unduhan aman (spec §3).
      setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);

      cleanupJob();
      setPhase('completed');
      setProgress(produced, state.total || produced);
      setStatusMessage(
        'File "' + a.download + '" terunduh (aktual ' + U.formatBytes(blob.size) +
        ', estimasi ' + U.formatBytes(state.total) + ').'
      );
    } catch (err) {
      if (url) URL.revokeObjectURL(url);
      cleanupJob();
      setPhase('error');
      setStatusMessage('Gagal membuat file: ' + (err && err.message ? err.message : err), true);
    }
  }

  /** Bersihkan resource job aktif (worker/timer/generator/chunks). */
  function cleanupJob() {
    if (state.worker) {
      state.worker.onmessage = null;
      state.worker.onerror = null;
      state.worker.terminate();
      state.worker = null;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.gen = null;
    state.chunks = [];
    state.cancelRequested = false;
  }

  // ------------------------------------------------------- Cancel mechanism
  function cancelCurrent() {
    if (state.phase !== 'generating') return;
    state.cancelRequested = true;

    if (state.worker) {
      // Worker memproses pesan ini di tick berikutnya lalu membalas
      // {type:'cancelled'} → status final ditangani di handleWorkerMessage.
      state.worker.postMessage({ type: 'cancel' });
      setStatusMessage('Membatalkan...');
    } else {
      // Fallback: hentikan tick loop di main thread secara langsung.
      cleanupJob();
      setPhase('cancelled');
      setStatusMessage('Dibatalkan pada ' + U.formatBytes(state.received) + '.');
    }
  }

  // ------------------------------------------------ Fallback tanpa Worker
  function startFallbackJob(text, count, separator) {
    // Algoritme chunking yang sama, dijalankan di main thread per-tick via
    // setTimeout(0) agar UI thread tetap responsif (spec §3).
    state.gen = U.createChunkGenerator({
      text: text,
      count: count,
      separator: separator,
      chunkSize: DEFAULT_CHUNK_SIZE
    });
    setStatusMessage('Proses berjalan (mode chunking tanpa Worker)...');

    const tick = () => {
      if (state.phase !== 'generating' || !state.gen) return; // dibatalkan/di-reset
      let processed = 0;
      let r;
      while (processed < FALLBACK_TICK_BUDGET) {
        r = state.gen.next();
        if (r.done) {
          const produced = r.produced;
          state.gen = null;
          assembleAndDownload(state.chunks, produced);
          return;
        }
        state.chunks.push(r.chunk);
        state.received = r.produced;
        processed += r.chunk.length;
      }
      setProgress(state.received, state.total);
      state.timer = setTimeout(tick, 0);
    };
    tick();
  }

  // ------------------------------------------------------------------- Init
  function init() {
    initDomRefs();

    els['generator-form'].addEventListener('submit', generateAndDownload);
    els['cancel-btn'].addEventListener('click', cancelCurrent);
    els['text-input'].addEventListener('input', updateEstimate);
    els['count-input'].addEventListener('input', updateEstimate);
    els['separator-input'].addEventListener('input', updateEstimate);

    setPhase('idle');
    updateEstimate();
    setStatusMessage(
      ensureWorkerUrl()
        ? 'Siap \u2022 mode Web Worker aktif.'
        : 'Siap \u2022 Web Worker tidak tersedia, memakai mode chunking.'
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
