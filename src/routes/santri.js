const express = require('express');
const { requireLogin, requireRole } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { logAudit } = require('../utils/audit');
const https = require('https');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const multerExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const uploadDir = path.join(__dirname, '../../public/uploads/fotos');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `foto_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`;
    cb(null, name);
  },
});
const fileFilter = (req, file, cb) => {
  const ok = ['image/jpeg', 'image/png', 'image/jpg'].includes(file.mimetype);
  cb(ok ? null : new Error('Tipe file harus JPG/PNG'), ok);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 2 * 1024 * 1024 } });

module.exports = function (pool) {
  const router = express.Router();
  function normalizeHeader(h){
    return String(h||'').toLowerCase().replace(/[^a-z0-9]+/g,'').trim();
  }
  function resolveCsvUrl(sheetUrl, sheetName){
    try{
      const m = String(sheetUrl||'').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      if (!m) return null;
      const id = m[1];
      const base = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
      if (sheetName && sheetName.trim()){ return base + `&sheet=` + encodeURIComponent(sheetName.trim()); }
      return base;
    }catch(e){ return null; }
  }
  function fetchText(url){
    return new Promise((resolve, reject) => {
      try{
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
            return resolve(fetchText(res.headers.location));
          }
          if (res.statusCode !== 200){
            return reject(new Error('HTTP ' + res.statusCode));
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', reject);
      }catch(err){ reject(err); }
    });
  }
  function toDateISO(v){
    if (!v) return null; const s = String(v).trim(); if (!s) return null;
    const parts = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/) || s.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    try{
      if (parts){
        if (parts[1].length === 4){
          const y = parseInt(parts[1],10), m = parseInt(parts[2],10)-1, d = parseInt(parts[3],10);
          const dt = new Date(Date.UTC(y, m, d)); return dt.toISOString().slice(0,10);
        } else {
          const d = parseInt(parts[1],10), m = parseInt(parts[2],10)-1, y = parseInt(parts[3],10);
          const dt = new Date(Date.UTC(y, m, d)); return dt.toISOString().slice(0,10);
        }
      }
    }catch(e){}
    return null;
  }
  function mapRow(headers, row){
    const idx = {}; headers.forEach((h, i) => { idx[normalizeHeader(h)] = i; });
    function pick(names){
      for (const n of names){ const key = normalizeHeader(n); if (key in idx) return row[idx[key]]; }
      const normalized = Object.keys(idx);
      for (const k of normalized){ for (const n of names){ if (k.includes(normalizeHeader(n))) return row[idx[k]]; } }
      return undefined;
    }
    const nis = pick(['nis','nisn','noinduk','no_siswa']);
    const nama = pick(['nama','namalengkap','name','namasantri']);
    const kelas = pick(['kelas','jurusan','grade']);
    const kelompok = pick(['kelompok','asrama','pondok','group','unit']);
    const tgl_lahir_raw = pick(['tgllahir','tanggallahir','dob']);
    const alamat = pick(['alamat','address']);
    const hp_wali = pick(['hpwali','nohporangtua','telpwali','nohp','kontakwali']);
    const tgl_lahir = toDateISO(tgl_lahir_raw);
    return { nis, nama, kelas, kelompok, tgl_lahir, alamat, hp_wali };
  }

  // List dengan pencarian (q opsional)
  router.get('/', requireLogin, requireRole('admin'), async (req, res) => {
    const q = (req.query.q || '').trim();
    let rows;
    if (q) {
      const like = `%${q}%`;
      [rows] = await pool.query(
        'SELECT * FROM santri WHERE nama LIKE ? OR nis LIKE ? OR kelas LIKE ? OR kelompok LIKE ? ORDER BY nama ASC',
        [like, like, like, like]
      );
    } else {
      [rows] = await pool.query('SELECT * FROM santri ORDER BY nama ASC');
    }
    res.render('santri_list', { title: 'Data Santri', items: rows, q });
  });

  // Import page (admin)
  router.get('/import', requireLogin, requireRole('admin'), async (req, res) => {
    res.render('santri_import', { title: 'Impor Santri (Excel)', sheetUrl: '', sheetName: '', preview: null });
  });

  // Preview import (admin)
  router.post('/import/preview', requireLogin, requireRole('admin'), async (req, res) => {
    const { sheetUrl, sheetName } = req.body;
    try{
      const csvUrl = resolveCsvUrl(sheetUrl, sheetName);
      if (!csvUrl) throw new Error('URL Google Sheets tidak valid.');
      const text = await fetchText(csvUrl);
      const records = parse(text, { skip_empty_lines: true });
      if (!records.length) throw new Error('CSV kosong');
      const headers = records[0];
      const rows = records.slice(1, Math.min(records.length, 11)).map(r => mapRow(headers, r));
      res.render('santri_import', { title: 'Impor Santri', sheetUrl, sheetName, preview: { columns: headers, rows } });
    }catch(err){
      console.error('Preview impor santri error:', err);
      req.session.flash = { type: 'error', message: 'Gagal preview impor: ' + err.message };
      res.redirect('/santri/import');
    }
  });

  // Jalankan impor (admin)
  router.post('/import/run', requireLogin, requireRole('admin'), async (req, res) => {
    const { sheetUrl, sheetName } = req.body;
    try{
      const csvUrl = resolveCsvUrl(sheetUrl, sheetName);
      if (!csvUrl) throw new Error('URL Google Sheets tidak valid.');
      const text = await fetchText(csvUrl);
      const records = parse(text, { skip_empty_lines: true });
      if (records.length < 2) throw new Error('Tidak ada baris data.');
      const headers = records[0];
      let inserted = 0, updated = 0, skipped = 0;
      const values = [];
      for (let i = 1; i < records.length; i++){
        const r = mapRow(headers, records[i]);
        if (!r.nis || !r.nama){ skipped++; continue; }
        const rowVals = [r.nis, r.nama, r.kelas || null, r.kelompok || null, r.tgl_lahir || null, r.alamat || null, r.hp_wali || null];
        values.push(rowVals);
      }
      if (values.length){
        const nisList = values.map(v => v[0]);
        // existing before insert
        const [existingBefore] = await pool.query('SELECT nis FROM santri WHERE nis IN (' + nisList.map(() => '?').join(',') + ')', nisList);
        const beforeSet = new Set(existingBefore.map(x => x.nis));
        const placeholders = values.map(() => '(?,?,?,?,?,?,?)').join(',');
        const sql = 'INSERT INTO santri (nis, nama, kelas, kelompok, tgl_lahir, alamat, hp_wali) VALUES ' + placeholders +
          ' ON DUPLICATE KEY UPDATE nama=VALUES(nama), kelas=VALUES(kelas), kelompok=VALUES(kelompok), tgl_lahir=VALUES(tgl_lahir), alamat=VALUES(alamat), hp_wali=VALUES(hp_wali)';
        await pool.query(sql, values.flat());
        const [existingAfter] = await pool.query('SELECT nis FROM santri WHERE nis IN (' + nisList.map(() => '?').join(',') + ')', nisList);
        const afterSet = new Set(existingAfter.map(x => x.nis));
        nisList.forEach(n => { if (!beforeSet.has(n) && afterSet.has(n)) inserted++; else if (beforeSet.has(n)) updated++; });
      }
      req.session.flash = { type: 'success', message: `Impor selesai. Ditambahkan: ${inserted}, Diperbarui: ${updated}, Diskip: ${skipped}.` };
      res.redirect('/santri');
    }catch(err){
      console.error('Run impor santri error:', err);
      req.session.flash = { type: 'error', message: 'Gagal impor: ' + err.message };
      res.redirect('/santri/import');
    }
  });

  // Alternatif GET trigger (tanpa CSRF, tetap admin-only)
  router.get('/import/run', requireLogin, requireRole('admin'), async (req, res) => {
    const { sheetUrl, sheetName } = req.query;
    try{
      const csvUrl = resolveCsvUrl(sheetUrl, sheetName);
      if (!csvUrl) throw new Error('URL Google Sheets tidak valid.');
      const text = await fetchText(csvUrl);
      const records = parse(text, { skip_empty_lines: true });
      if (records.length < 2) throw new Error('Tidak ada baris data.');
      const headers = records[0];
      let inserted = 0, updated = 0, skipped = 0;
      const values = [];
      for (let i = 1; i < records.length; i++){
        const r = mapRow(headers, records[i]);
        if (!r.nis || !r.nama){ skipped++; continue; }
        const rowVals = [r.nis, r.nama, r.kelas || null, r.kelompok || null, r.tgl_lahir || null, r.alamat || null, r.hp_wali || null];
        values.push(rowVals);
      }
      if (values.length){
        const nisList = values.map(v => v[0]);
        const [existingBefore] = await pool.query('SELECT nis FROM santri WHERE nis IN (' + nisList.map(() => '?').join(',') + ')', nisList);
        const beforeSet = new Set(existingBefore.map(x => x.nis));
        const placeholders = values.map(() => '(?,?,?,?,?,?,?)').join(',');
        const sql = 'INSERT INTO santri (nis, nama, kelas, kelompok, tgl_lahir, alamat, hp_wali) VALUES ' + placeholders +
          ' ON DUPLICATE KEY UPDATE nama=VALUES(nama), kelas=VALUES(kelas), kelompok=VALUES(kelompok), tgl_lahir=VALUES(tgl_lahir), alamat=VALUES(alamat), hp_wali=VALUES(hp_wali)';
        await pool.query(sql, values.flat());
        const [existingAfter] = await pool.query('SELECT nis FROM santri WHERE nis IN (' + nisList.map(() => '?').join(',') + ')', nisList);
        const afterSet = new Set(existingAfter.map(x => x.nis));
        nisList.forEach(n => { if (!beforeSet.has(n) && afterSet.has(n)) inserted++; else if (beforeSet.has(n)) updated++; });
      }
      req.session.flash = { type: 'success', message: `Impor selesai. Ditambahkan: ${inserted}, Diperbarui: ${updated}, Diskip: ${skipped}.` };
      res.redirect('/santri');
    }catch(err){
      console.error('Run impor santri (GET) error:', err);
      req.session.flash = { type: 'error', message: 'Gagal impor: ' + err.message };
      res.redirect('/santri/import');
    }
  });

  // Preview Excel (.xlsx) import (admin)
  router.post('/import/excel/preview', requireLogin, requireRole('admin'), multerExcel.single('excel'), async (req, res) => {
    try{
      if (!req.file) throw new Error('File Excel tidak ditemukan.');
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const targetName = wb.SheetNames[0];
      const sheet = wb.Sheets[targetName];
      const rowsArr = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
      if (!rowsArr.length) throw new Error('Sheet kosong.');
      const headers = rowsArr[0];
      const rows = rowsArr.slice(1, Math.min(rowsArr.length, 11)).map(r => mapRow(headers, r));
      res.render('santri_import', { title: 'Impor Santri (Excel)', sheetUrl: '', sheetName: targetName, preview: { rows } });
    }catch(err){
      console.error('Preview impor Excel error:', err);
      req.session.flash = { type: 'error', message: 'Gagal preview Excel: ' + err.message };
      res.redirect('/santri/import');
    }
  });

  // Run Excel (.xlsx) import (admin)
  router.post('/import/excel/run', requireLogin, requireRole('admin'), multerExcel.single('excel'), async (req, res) => {
    try{
      if (!req.file) throw new Error('File Excel tidak ditemukan.');
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const targetName = wb.SheetNames[0];
      const sheet = wb.Sheets[targetName];
      const rowsArr = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
      if (rowsArr.length < 2) throw new Error('Tidak ada baris data.');
      const headers = rowsArr[0];
      let inserted = 0, updated = 0, skipped = 0;
      const values = [];
      for (let i = 1; i < rowsArr.length; i++){
        const r = mapRow(headers, rowsArr[i]);
        if (!r.nis || !r.nama){ skipped++; continue; }
        const rowVals = [r.nis, r.nama, r.kelas || null, r.kelompok || null, r.tgl_lahir || null, r.alamat || null, r.hp_wali || null];
        values.push(rowVals);
      }
      if (values.length){
        const nisList = values.map(v => v[0]);
        const [existingBefore] = await pool.query('SELECT nis FROM santri WHERE nis IN (' + nisList.map(() => '?').join(',') + ')', nisList);
        const beforeSet = new Set(existingBefore.map(x => x.nis));
        const placeholders = values.map(() => '(?,?,?,?,?,?,?)').join(',');
        const sql = 'INSERT INTO santri (nis, nama, kelas, kelompok, tgl_lahir, alamat, hp_wali) VALUES ' + placeholders +
          ' ON DUPLICATE KEY UPDATE nama=VALUES(nama), kelas=VALUES(kelas), kelompok=VALUES(kelompok), tgl_lahir=VALUES(tgl_lahir), alamat=VALUES(alamat), hp_wali=VALUES(hp_wali)';
        await pool.query(sql, values.flat());
        const [existingAfter] = await pool.query('SELECT nis FROM santri WHERE nis IN (' + nisList.map(() => '?').join(',') + ')', nisList);
        const afterSet = new Set(existingAfter.map(x => x.nis));
        nisList.forEach(n => { if (!beforeSet.has(n) && afterSet.has(n)) inserted++; else if (beforeSet.has(n)) updated++; });
      }
      req.session.flash = { type: 'success', message: `Impor Excel selesai. Ditambahkan: ${inserted}, Diperbarui: ${updated}, Diskip: ${skipped}.` };
      res.redirect('/santri');
    }catch(err){
      console.error('Run impor Excel error:', err);
      req.session.flash = { type: 'error', message: 'Gagal impor Excel: ' + err.message };
      res.redirect('/santri/import');
    }
  });

  // API pencarian cepat santri (admin)
  router.get('/search', requireLogin, requireRole('admin'), async (req, res) => {
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '12', 10) || 12, 50);
    if (!q) return res.json([]);
    try {
      const [prefixRows] = await pool.query(
        'SELECT id, nis, nama, kelas, kelompok, foto_path, saldo FROM santri WHERE nama LIKE CONCAT(?, "%") ORDER BY nama ASC LIMIT ?',
        [q, limit]
      );
      let results = prefixRows;
      if (results.length < limit && q.length >= 3) {
        const [containsRows] = await pool.query(
          'SELECT id, nis, nama, kelas, kelompok, foto_path, saldo FROM santri WHERE nama LIKE ? OR nis LIKE ? OR kelas LIKE ? OR kelompok LIKE ? ORDER BY nama ASC LIMIT ?',
          [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, limit]
        );
        const existing = new Set(results.map(r => r.id));
        for (const r of containsRows) {
          if (!existing.has(r.id)) {
            results.push(r);
            existing.add(r.id);
          }
          if (results.length >= limit) break;
        }
      }
      res.json(results);
    } catch (err) {
      console.error('Santri search error:', err);
      res.status(500).json({ error: 'search_failed' });
    }
  });

  // Create form
  router.get('/new', requireLogin, requireRole('admin'), (req, res) => {
    res.render('santri_form', { title: 'Tambah Santri', item: null });
  });

  // Create
  router.post('/new', requireLogin, requireRole('admin'), upload.single('foto'), async (req, res) => {
    const { nis, nama, kelas, kelompok, tgl_lahir, alamat, hp_wali } = req.body;
    if (!nis || !nama) {
      req.session.flash = { type: 'error', message: 'NIS dan Nama wajib diisi.' };
      return res.redirect('/santri/new');
    }
    try {
      const fotoPath = req.file ? path.join('uploads', 'fotos', req.file.filename) : null;
      const [result] = await pool.query(
        'INSERT INTO santri (nis, nama, kelas, kelompok, tgl_lahir, alamat, hp_wali, foto_path) VALUES (?,?,?,?,?,?,?,?)',
        [nis, nama, kelas || null, kelompok || null, tgl_lahir || null, alamat || null, hp_wali || null, fotoPath]
      );
      await logAudit(pool, req, { action: 'create', entity: 'santri', entity_id: String(result.insertId), details: { nis, nama } });
      req.session.flash = { type: 'success', message: 'Santri berhasil ditambahkan.' };
      res.redirect('/santri');
    } catch (err) {
      console.error(err);
      req.session.flash = { type: 'error', message: 'Gagal menambah santri: kemungkinan NIS duplikat.' };
      res.redirect('/santri/new');
    }
  });

  // Edit form
  router.get('/:id/edit', requireLogin, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM santri WHERE id = ?', [id]);
    if (!rows.length) {
      req.session.flash = { type: 'error', message: 'Santri tidak ditemukan.' };
      return res.redirect('/santri');
    }
    res.render('santri_form', { title: 'Edit Santri', item: rows[0] });
  });

  // Update
  router.post('/:id/edit', requireLogin, requireRole('admin'), upload.single('foto'), async (req, res) => {
    const { id } = req.params;
    const { nis, nama, kelas, kelompok, tgl_lahir, alamat, hp_wali } = req.body;
    try {
      if (req.file) {
        const newFotoPath = path.join('uploads', 'fotos', req.file.filename);
        const [[row]] = await pool.query('SELECT foto_path FROM santri WHERE id=?', [id]);
        await pool.query(
          'UPDATE santri SET nis=?, nama=?, kelas=?, kelompok=?, tgl_lahir=?, alamat=?, hp_wali=?, foto_path=? WHERE id=?',
          [nis, nama, kelas || null, kelompok || null, tgl_lahir || null, alamat || null, hp_wali || null, newFotoPath, id]
        );
        if (row && row.foto_path) {
          const oldPath = path.join(__dirname, '../../public', row.foto_path);
          try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (e) {}
        }
      } else {
        await pool.query(
          'UPDATE santri SET nis=?, nama=?, kelas=?, kelompok=?, tgl_lahir=?, alamat=?, hp_wali=? WHERE id=?',
          [nis, nama, kelas || null, kelompok || null, tgl_lahir || null, alamat || null, hp_wali || null, id]
        );
      }
      await logAudit(pool, req, { action: 'update', entity: 'santri', entity_id: id, details: { nis, nama } });
      req.session.flash = { type: 'success', message: 'Santri berhasil diperbarui.' };
      res.redirect('/santri');
    } catch (err) {
      console.error(err);
      req.session.flash = { type: 'error', message: 'Gagal memperbarui santri.' };
      res.redirect(`/santri/${id}/edit`);
    }
  });

  // Delete
  router.post('/:id/delete', requireLogin, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    try {
      const [[row]] = await pool.query('SELECT foto_path FROM santri WHERE id=?', [id]);
      await pool.query('DELETE FROM santri WHERE id=?', [id]);
      if (row && row.foto_path) {
        const oldPath = path.join(__dirname, '../../public', row.foto_path);
        try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (e) {}
      }
      await logAudit(pool, req, { action: 'delete', entity: 'santri', entity_id: id });
      req.session.flash = { type: 'success', message: 'Santri berhasil dihapus.' };
      res.redirect('/santri');
    } catch (err) {
      console.error(err);
      req.session.flash = { type: 'error', message: 'Gagal menghapus santri.' };
      res.redirect('/santri');
    }
  });

  // Detail santri & riwayat transaksi (admin/kasir)
  router.get('/:id', requireLogin, async (req, res) => {
    const { id } = req.params;
    const [[santri]] = await pool.query('SELECT * FROM santri WHERE id=?', [id]);
    if (!santri) {
      req.session.flash = { type: 'error', message: 'Santri tidak ditemukan.' };
      return res.redirect('/santri');
    }
    const [trx] = await pool.query(
      'SELECT t.*, u.full_name AS kasir_name FROM transaksi t LEFT JOIN users u ON t.user_id=u.id WHERE santri_id=? ORDER BY created_at DESC',
      [id]
    );
    res.render('santri_detail', { title: 'Detail Santri', santri, transaksi: trx });
  });

  return router;
};