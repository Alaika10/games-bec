# HACK THE SYSTEM: Reading Escape Room

Aplikasi web lomba membaca bahasa Inggris berkelompok bergaya terminal hacker dengan papan skor real-time, layar proyektor tanpa input, dan panel kontrol admin.

## Rute Utama
- `/` — **Halaman Kelompok** (untuk HP peserta, mobile-first).
- `/layar` — **Layar Proyektor** (tampilan besar real-time, timer, banner pembukaan kunci, dan podium 3 besar).
- `/admin` — **Panel Kontrol Admin** (dilindungi PIN).

## Data Awal Bawaan (Seed)
Saat pertama kali dijalankan, sistem otomatis membuat sesi awal:
- **Kode Sesi**: `4821`
- **PIN Admin**: `2026`
- **Durasi**: `85 menit`
- **Lembar 1**: Kode `RX-42` · Kunci `231` · Petunjuk: *Cari kalimat yang merangkum seluruh artikel.*
- **Lembar 2**: Kode `KM-17` · Kunci `3201912` (`3-2019-12`) · Petunjuk: *Cari angka dan tahun di dua paragraf pertama.*
- **Lembar 3**: Kode `BT-83` · Kunci `214305` (`21-4-305`) · Petunjuk: *Lihat paragraf pertama dan kedua email.*
- **Lembar 4**: Kode `ZQ-06` · Kunci `322` · Petunjuk: *Perhatikan apa yang tidak dilakukan oleh salah satu tokoh.*
- **Lembar 5**: Kode `HV-59` · Kunci `LOCK` · Petunjuk: *Ambil huruf pertama dari jawaban nomor 2 sampai 5.*

## 1. Cara Membuat Sesi Baru
1. Buka `/admin`, masukkan **Kode Sesi** yang aktif (bawaan: `4821`) dan **PIN Admin** (`2026`).
2. Klik tombol **Buat Sesi Baru** di bilah kontrol atas.
3. Isi **Kode Sesi Baru** (4 digit angka), **Judul Sesi**, **PIN Admin** baru, dan **Durasi (menit)**, lalu klik **Buat Sesi**.
4. Sistem otomatis beralih ke sesi baru tersebut dengan data awal 5 lembar siap pakai.

## 2. Cara Mengubah Kunci, Kode Lembar, Petunjuk, dan Poin
1. Di halaman `/admin`, buka tab **Konten Lembar & Poin**.
2. Ubah **Kode Lembar**, **Kunci**, atau **Teks Petunjuk** untuk Lembar 1 hingga Lembar 5.
   - Kunci otomatis dinormalisasi (huruf besar, tanpa spasi dan tanda strip `-`).
3. Anda juga dapat menyesuaikan nilai **Aturan Poin** (Kunci Benar, Bonus Tercepat, Final Pertama, Kode Salah, Petunjuk, Kunci Darurat), durasi, serta mengganti PIN Admin.
4. Klik **Simpan Pengaturan Lembar & Poin**.

## 3. Cara Menjalankan Saat Acara
1. **Persiapan Ruangan**: Lipat 5 lembar teks fisik, tuliskan kode lembar (`RX-42`, `KM-17`, `BT-83`, `ZQ-06`, `HV-59`) di sisi luarnya, lalu sebar di ruangan.
2. **Proyektor**: Buka `/layar` (atau `/layar?kode=4821` untuk sesi spesifik) di komputer yang terhubung ke proyektor. Klik **Aktifkan Audio** di pojok kanan atas agar bunyi notifikasi saat tim membuka kunci aktif.
3. **Registrasi Peserta**: Minta setiap kelompok (1 HP per kelompok) membuka `/`, memilih **Daftar Kelompok**, memasukkan Kode Sesi 4 digit, Nama Kelompok, dan 2–5 nama anggota.
4. **Kode Kelompok & Suara**: Pastikan setiap kelompok mencatat **Kode Kelompok 4 karakter** (untuk masuk kembali jika halaman tertutup) dan menekan tombol besar **AKTIFKAN SUARA**.
5. **Mulai Lomba**: Di `/admin`, tekan **MULAI**. Timer langsung berjalan serentak dan seluruh HP menampilkan `CARI LEMBAR BERKODE: RX-42`.
6. **Selama Lomba**: Pantau tab **Antrean Permintaan** untuk menyetujui/menolak permintaan petunjuk atau kunci darurat, serta gunakan tombol **+/- Poin** di tab **Kelompok** untuk bonus/penalti manual (misalnya ringkasan atau warm-up).
7. **Selesai & Ekspor**: Tekan **AKHIRI** untuk menampilkan **Podium 3 Besar** di proyektor, lalu unduh hasil akhir dan log aktivitas melalui tab **Log & Ekspor CSV**.
