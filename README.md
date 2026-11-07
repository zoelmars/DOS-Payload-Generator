# DOS-Payload-Generator

Tool web **client-side** untuk meng-generate file `.txt` berisi teks berulang
berukuran besar (jutaan karakter) dan langsung mengunduhnya — **tanpa backend,
tanpa framework, tanpa render ke DOM**. UI tetap responsif walau memproses
puluhan juta karakter, thanks to Web Worker.

> ⚠️ **Disclaimer:** gunakan hanya pada sistem milik sendiri atau yang punya
> otorisasi tertulis (lab pribadi, DVWA, target bug bounty yang mengizinkan).
> Jangan digunakan untuk mengganggu layanan pihak lain — itu ilegal.

## Cara Instalasi

### Opsi 1 — Clone & langsung pakai (tanpa install apa pun)

```bash
git clone git@github.com:zoelmars/DOS-Payload-Generator.git
cd DOS-Payload-Generator
xdg-open index.html        # Linux; macOS: open index.html; Windows: double-click
```

Selesai. Tidak ada dependency, tidak perlu build — semuanya jalan di browser.

### Opsi 2 — Serve via local server (opsional)

```bash
git clone git@github.com:zoelmars/DOS-Payload-Generator.git
cd DOS-Payload-Generator
python3 -m http.server 8000
# buka http://localhost:8000 di browser
```

### Jalankan unit test (opsional, butuh Node.js ≥ 14)

```bash
node tests/run_tests.js    # atau: npm test
```

## Cara Pakai

1. Isi **Teks** — teks yang mau diulang.
2. Isi **Jumlah Pengulangan** (misal `1000000`).
3. (Opsional) isi **Separator** — dukung escape `\n` (baris baru), `\t` (tab), `\r`.
4. (Opsional) ganti **Nama File** — otomatis ditambah `.txt`.
5. Klik **Generate & Download** → file `.txt` langsung terunduh.
6. Mau berhenti di tengah jalan? Klik **Cancel**.


- Input teks, jumlah pengulangan, separator (dukung escape `\n`, `\t`, `\r`), nama file.
- **Estimated size** real-time (B/KB/MB) + soft-limit 50 juta karakter.
- Progress bar + status `idle / generating... / completed / cancelled / error`.
- Tombol **Cancel** yang benar-benar menghentikan proses di tengah jalan.
- File otomatis di-download sebagai `.txt` (nama disanitasi).

## Arsitektur & Performa

| Kebutuhan | Implementasi |
|---|---|
| Zero DOM rendering | Hasil generate langsung dikumpulkan sebagai array chunk → `new Blob(chunks)` → `a[download]`. Tidak pernah disentuh `<textarea>`/`<div>`. |
| Non-blocking | Proses berat jalan di **Web Worker**. Di dalam worker, job dipecah per-tick `setTimeout(0)` supaya pesan `cancel` tetap bisa diproses. Fallback tanpa Worker: chunking `setTimeout(0)` di main thread. |
| Web Worker via `file://` | `new Worker('worker.js')` gagal di `file://` (CORS). Solusi: body worker ditulis sebagai satu fungsi `workerMain(self)` lalu di-serialize via `Function.prototype.toString()` → dirakit `createWorkerSource()` → **Blob URL** → `new Worker(blobUrl)`. |
| Memory management | Piece tidak dimaterialisasi jadi array raksasa (index-based: genap → teks, ganjil → separator); hanya chunk aktif (~1 MB) di memori. `URL.revokeObjectURL()` dipanggil 10 detik setelah download dimulai. |
| Cancel | `AbortController`-style: main thread kirim `{type:'cancel'}` → worker clear timer + balas `{type:'cancelled', produced}`. Fallback: flag phase dicek tiap tick. |
| Unicode | Estimasi dihitung per karakter (UTF-16 units); ukuran aktual `Blob.size` ditampilkan setelah download. |

## Struktur Proyek

```
DOS-Payload-Generator/
├── index.html          # UI (tema putih-ungu, form semantik)
├── style.css           # Styling + responsive
├── utils.js            # Helper murni: kalkulasi, format, chunk generator
├── worker.js           # Logika Web Worker (+ createWorkerSource untuk Blob URL)
├── app.js              # Controller UI (validasi, worker, download, cancel)
└── tests/run_tests.js  # Unit & integration test (Node, tanpa dependency)
```

## Protokol Pesan Worker

```
main → worker : { type: 'generate', text, count, separator, chunkSize? }
                { type: 'cancel' }
worker → main : { type: 'start' }
                { type: 'progress', produced, chunk }
                { type: 'complete', produced }
                { type: 'cancelled', produced }
                { type: 'error', message }
```

## Catatan

- Estimasi ukuran = `panjang_teks × jumlah + panjang_separator × (jumlah − 1)`.
  Untuk input ASCII hasilnya **persis** sama dengan ukuran file; untuk emoji/
  karakter non-Latin, file UTF-8 bisa lebih besar (ukuran aktual tetap
  ditampilkan setelah download).
- `workerMain` di-serialize apa adanya — jangan minify kode ini kalau masih
  mau pakai mekanisme Blob URL (nama identifier harus terjaga).
