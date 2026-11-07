'use strict';

/* ============================================================================
 * tests/run_tests.js — Unit & integration test (Node.js, tanpa dependency)
 *
 * Jalankan: node tests/run_tests.js   (atau: npm test)
 *
 * Yang diuji:
 *   1. utils.js  : kalkulasi, format, generator chunk, sanitasi nama file
 *   2. worker.js : workerMain end-to-end via fake `self` (direct + vm sandbox
 *                  yang mengeksekusi createWorkerSource() persis seperti di
 *                  browser), cancel mid-run, dan error path.
 * ========================================================================== */

const path = require('path');
const vm = require('vm');

const U = require(path.join(__dirname, '..', 'utils.js'));
const W = require(path.join(__dirname, '..', 'worker.js'));

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log('  \u2713 ' + name);
  } else {
    failed += 1;
    console.error('  \u2717 ' + name + (extra !== undefined ? '  => ' + JSON.stringify(extra) : ''));
  }
}

function section(title) {
  console.log('\n[' + title + ']');
}

function waitFor(condFn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      if (condFn()) return resolve();
      if (Date.now() - started > (timeoutMs || 5000)) {
        return reject(new Error('timeout menunggu kondisi test'));
      }
      setTimeout(poll, 5);
    })();
  });
}

/** Jalankan generator sampai selesai, kumpulkan semua chunk. */
function runGenerator(text, count, separator, chunkSize) {
  const gen = U.createChunkGenerator({ text, count, separator, chunkSize });
  let joined = '';
  let lastProduced = 0;
  let chunks = 0;
  let produced = 0;
  for (let guard = 0; guard < 10000000; guard += 1) {
    const r = gen.next();
    if (r.done) {
      produced = r.produced;
      break;
    }
    if (r.produced < lastProduced) throw new Error('progress produced menurun');
    lastProduced = r.produced;
    joined += r.chunk;
    chunks += 1;
  }
  return { joined, produced, chunks };
}

/** Jalankan workerMain langsung (Node) dengan fake self, tunggu pesan final. */
function runWorkerJob(payload) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const fakeSelf = {
      postMessage: (m) => messages.push(m),
      onmessage: null
    };
    W.workerMain(fakeSelf, U);
    fakeSelf.onmessage({ data: payload });
    waitFor(() =>
      messages.some((m) => m.type === 'complete' || m.type === 'error' || m.type === 'cancelled')
    )
      .then(() => resolve(messages))
      .catch(reject);
  });
}

function joinedFrom(messages) {
  return messages
    .filter((m) => m.type === 'progress')
    .map((m) => m.chunk)
    .join('');
}

async function main() {
  // -------------------------------------------------------------- utils.js
  section('computeTotalLength & estimateBytes');
  check('dasar (5,3,2) = 19', U.computeTotalLength(5, 3, 2) === 19, U.computeTotalLength(5, 3, 2));
  check('count 1 → panjang teks saja', U.computeTotalLength(5, 1, 9) === 5);
  check('count 0 → 0', U.computeTotalLength(5, 0, 9) === 0);
  check('overflow → Infinity', U.computeTotalLength(1e9, 1e9, 0) === Infinity);
  check("estimateBytes('abc',2,',') = 7", U.estimateBytes('abc', 2, ',') === 7, U.estimateBytes('abc', 2, ','));

  section('formatBytes & formatCount');
  check('0 → 0 B', U.formatBytes(0) === '0 B', U.formatBytes(0));
  check('999 → 999 B', U.formatBytes(999) === '999 B', U.formatBytes(999));
  check('1000 → 1.0 KB', U.formatBytes(1000) === '1.0 KB', U.formatBytes(1000));
  check('1048576 → 1.0 MB', U.formatBytes(1048576) === '1.0 MB', U.formatBytes(1048576));
  check('123456789 → 123.5 MB', U.formatBytes(123456789) === '123.5 MB', U.formatBytes(123456789));
  check('999999999 → 1.0 GB (tanpa "1000.0 MB")', U.formatBytes(999999999) === '1.0 GB', U.formatBytes(999999999));
  check('Infinity → ∞', U.formatBytes(Infinity) === '\u221E', U.formatBytes(Infinity));
  check('negatif → —', U.formatBytes(-5) === '\u2014', U.formatBytes(-5));
  check('9999 → "9999"', U.formatCount(9999) === '9999', U.formatCount(9999));
  check('15000 → 15 rb', U.formatCount(15000) === '15 rb', U.formatCount(15000));
  check('2500000 → 2.5 jt', U.formatCount(2500000) === '2.5 jt', U.formatCount(2500000));
  check('1200000000 → 1.2 M', U.formatCount(1200000000) === '1.2 M', U.formatCount(1200000000));

  section('normalizeFilename & unescapeSeparator');
  check("'' → result.txt", U.normalizeFilename('') === 'result.txt', U.normalizeFilename(''));
  check("'hasil' → hasil.txt", U.normalizeFilename('hasil') === 'hasil.txt', U.normalizeFilename('hasil'));
  check("'a.txt' tetap", U.normalizeFilename('a.txt') === 'a.txt');
  check("'A.TXT' tetap (case-insensitive)", U.normalizeFilename('A.TXT') === 'A.TXT');
  check('karakter ilegal disanitasi', U.normalizeFilename('we/ird:name*') === 'we-ird-name-.txt', U.normalizeFilename('we/ird:name*'));
  check('trim spasi', U.normalizeFilename('  laporan  ') === 'laporan.txt', U.normalizeFilename('  laporan  '));
  check("'\\n' → newline", U.unescapeSeparator('\\n') === '\n', JSON.stringify(U.unescapeSeparator('\\n')));
  check("'a\\tb' → tab", U.unescapeSeparator('a\\tb') === 'a\tb', JSON.stringify(U.unescapeSeparator('a\\tb')));
  check("', ' tidak diubah", U.unescapeSeparator(', ') === ', ');

  section('createChunkGenerator — kebenaran isi & progres');
  const cases = [
    { text: 'ab', count: 5, separator: '-', chunkSize: 4 },
    { text: 'xyz', count: 1, separator: '!!!', chunkSize: 10 },
    { text: '', count: 3, separator: '-', chunkSize: 5 },
    { text: 'ab', count: 2, separator: '-', chunkSize: 1 },
    { text: 'abcabc', count: 2, separator: '', chunkSize: 6 },
    { text: 'halo dunia ', count: 3, separator: '', chunkSize: 1000000 },
    { text: 'x', count: 0, separator: '-', chunkSize: 10 }
  ];
  for (const c of cases) {
    const expected = new Array(c.count).fill(c.text).join(c.separator);
    const r = runGenerator(c.text, c.count, c.separator, c.chunkSize);
    check(
      "'" + c.text + "' x" + c.count + " sep='" + c.separator + "' chunk=" + c.chunkSize,
      r.joined === expected && r.produced === expected.length && r.chunks >= 1,
      { got: r.joined, expected: expected, produced: r.produced }
    );
  }
  // produced harus konsisten dengan rumus estimasi
  for (const c of cases) {
    const r = runGenerator(c.text, c.count, c.separator, c.chunkSize);
    const estimated = U.estimateBytes(c.text, c.count, c.separator);
    check(
      'estimasi === produced (' + c.text.slice(0, 6) + ' x' + c.count + ')',
      r.produced === estimated,
      { produced: r.produced, estimated: estimated }
    );
  }
  // Validasi input generator
  let threw = false;
  try { U.createChunkGenerator({ text: 'a', count: -1, separator: '' }); } catch (e) { threw = true; }
  check('count negatif → TypeError', threw);
  threw = false;
  try { U.createChunkGenerator({ text: 42, count: 2, separator: '' }); } catch (e) { threw = true; }
  check('text bukan string → TypeError', threw);

  // ------------------------------------------------------------ worker.js
  section('workerMain (direct, fake self) — job lengkap');
  {
    const messages = await runWorkerJob({ type: 'generate', text: 'hi', count: 3, separator: ',' });
    check('ada pesan start', messages.some((m) => m.type === 'start'));
    check("hasil 'hi,hi,hi'", joinedFrom(messages) === 'hi,hi,hi', JSON.stringify(joinedFrom(messages)));
    const comp = messages.find((m) => m.type === 'complete');
    check('complete produced = 8', Boolean(comp) && comp.produced === 8, comp);
  }
  {
    const messages = await runWorkerJob({ type: 'generate', text: 'x', count: 200000, separator: '' });
    check('job 200rb char: complete', messages.some((m) => m.type === 'complete'));
    check('job 200rb char: produced = 200000', messages.find((m) => m.type === 'complete').produced === 200000);
    check('job 200rb char: isi benar', joinedFrom(messages) === 'x'.repeat(200000));
  }

  section('workerMain — cancel mid-run');
  {
    // Job sengaja dibuat besar (100 juta char, budget 2M/tick → ~50+ tick)
    // supaya cancel benar-benar terjadi di tengah proses, bukan setelah selesai.
    const messages = [];
    const fakeSelf = { postMessage: (m) => messages.push(m), onmessage: null };
    W.workerMain(fakeSelf, U);
    fakeSelf.onmessage({
      data: { type: 'generate', text: 'x', count: 100000000, separator: '', chunkSize: 1000 }
    });
    await waitFor(() => messages.some((m) => m.type === 'progress'));
    fakeSelf.onmessage({ data: { type: 'cancel' } });
    await waitFor(() => messages.some((m) => m.type === 'cancelled'));
    check('cancel → tidak ada complete', !messages.some((m) => m.type === 'complete'));
    const cancelled = messages.find((m) => m.type === 'cancelled');
    check('cancelled membawa produced > 0', Boolean(cancelled) && cancelled.produced > 0, cancelled ? cancelled.produced : null);
  }

  section('workerMain — error path');
  {
    const messages = await runWorkerJob({ type: 'generate', text: 'a', count: 0, separator: '' });
    check('count 0 → pesan error', messages.some((m) => m.type === 'error'), messages);
    check('count 0 → tidak ada complete', !messages.some((m) => m.type === 'complete'));
  }
  {
    const messages = await runWorkerJob({ type: 'generate', text: 'a', count: 2.5, separator: '' });
    check('count pecahan → pesan error', messages.some((m) => m.type === 'error'));
  }
  {
    const messages = await runWorkerJob({ type: 'ngasal' });
    check('tipe pesan tak dikenal → error', messages.some((m) => m.type === 'error'));
  }

  section('createWorkerSource — eksekusi di vm sandbox (simulasi browser)');
  {
    const src = W.createWorkerSource();
    check('source memuat workerMain', src.includes('workerMain'));
    check('source memuat createChunkGenerator', src.includes('createChunkGenerator'));
    check('source tidak ada require()', !src.includes('require('));

    const messages = [];
    const fakeSelf = { postMessage: (m) => messages.push(m), onmessage: null };
    const sandbox = { self: fakeSelf, setTimeout: setTimeout, clearTimeout: clearTimeout };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    check('onmessage terpasang di self', typeof fakeSelf.onmessage === 'function');

    fakeSelf.onmessage({
      data: { type: 'generate', text: 'ab', count: 2, separator: '-', chunkSize: 3 }
    });
    await waitFor(() => messages.some((m) => m.type === 'complete' || m.type === 'error'));
    check('vm: tidak ada pesan error', !messages.some((m) => m.type === 'error'), messages);
    check("vm: hasil 'ab-ab'", joinedFrom(messages) === 'ab-ab', JSON.stringify(joinedFrom(messages)));
    const comp = messages.find((m) => m.type === 'complete');
    check('vm: complete produced = 5', Boolean(comp) && comp.produced === 5, comp);
  }

  // -------------------------------------------------------------- Ringkasan
  console.log('\n=============================================');
  console.log('Hasil: ' + passed + ' lulus, ' + failed + ' gagal');
  console.log('=============================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test crash:', err);
  process.exit(1);
});
