const express = require('express');
const { requireLogin, requireRole } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const { generatePenarikanPDF } = require('../utils/pdf');
const { logAudit } = require('../utils/audit');

const STORAGE_DIR = path.join(__dirname, '../../storage');
const SIGN_DIR = path.join(STORAGE_DIR, 'signatures');
const PDF_DIR = path.join(STORAGE_DIR, 'pdfs');

module.exports = function (pool) {
  const router = express.Router();
  // Guard saat DB offline: pastikan akses query aman
  const canQuery = !!(pool && typeof pool.query === 'function');
  const query = async (sql, params) => {
    if (!canQuery) return [[], []];
    return pool.query(sql, params);
  };

  // Setoran form (opsional santri_id via query)
  router.get('/setor', requireLogin, requireRole('kasir'), async (req, res) => {
    const { santri_id } = req.query;
    let santri = null;
    if (santri_id) {
      const [[row]] = await query('SELECT * FROM santri WHERE id=?', [santri_id]);
      santri = row || null;
    }
    const [presets] = await query('SELECT id, amount, label FROM preset_nominal WHERE active=1 AND tipe=? ORDER BY sort_order ASC, amount ASC', ['setor']);
    res.render('transaksi_form', { title: 'Transaksi Setoran', tipe: 'setor', santri, presets });
  });

  // Tarik form (opsional santri_id via query)
  router.get('/tarik', requireLogin, requireRole('kasir'), async (req, res) => {
    const { santri_id } = req.query;
    let santri = null;
    if (santri_id) {
      const [[row]] = await query('SELECT * FROM santri WHERE id=?', [santri_id]);
      santri = row || null;
    }
    const [presets] = await query('SELECT id, amount, label FROM preset_nominal WHERE active=1 AND tipe=? ORDER BY sort_order ASC, amount ASC', ['tarik']);
    res.render('transaksi_form', { title: 'Transaksi Penarikan', tipe: 'tarik', santri, presets });
  });

  // Cari santri by Nama (menampilkan daftar hasil di bawah form)
  router.post('/cari', requireLogin, requireRole('kasir'), async (req, res) => {
    const { nama, tipe } = req.body;
    const q = (nama || '').trim();
    if (!q) {
      req.session.flash = { type: 'error', message: 'Isi nama santri untuk mencari.' };
      return res.redirect(`/transaksi/${tipe}`);
    }
    if (!canQuery) {
      req.session.flash = { type: 'error', message: 'Database offline; pencarian tidak tersedia.' };
      return res.redirect(`/transaksi/${tipe}`);
    }
    const [rows] = await query('SELECT * FROM santri WHERE nama LIKE ? ORDER BY nama ASC', [`%${q}%`]);
    if (!rows.length) {
      req.session.flash = { type: 'error', message: 'Santri tidak ditemukan.' };
      return res.redirect(`/transaksi/${tipe}`);
    }
    if (rows.length === 1) {
      const tipeKey = tipe === 'setor' ? 'setor' : 'tarik';
      const [presets] = await query('SELECT id, amount, label FROM preset_nominal WHERE active=1 AND tipe=? ORDER BY sort_order ASC, amount ASC', [tipeKey]);
      return res.render('transaksi_form', { title: `Transaksi ${tipeKey === 'setor' ? 'Setoran' : 'Penarikan'}`, tipe, santri: rows[0], presets });
    }
    // tampilkan daftar hasil; user memilih salah satu (link ke /transaksi/{tipe}?santri_id=ID)
    res.render('transaksi_form', { title: `Transaksi ${tipe === 'setor' ? 'Setoran' : 'Penarikan'}`, tipe, santri: null, santriList: rows });
  });

  // Proses setoran
  router.post('/setor', requireLogin, requireRole('kasir'), async (req, res) => {
    const { santri_id, jumlah, keterangan } = req.body;
    const jml = parseInt(jumlah, 10);
    if (!santri_id || !jml || jml <= 0) {
      req.session.flash = { type: 'error', message: 'Data tidak valid.' };
      return res.redirect('/transaksi/setor');
    }
    if (!canQuery) {
      req.session.flash = { type: 'error', message: 'Database offline; tidak dapat mencatat setoran.' };
      return res.redirect('/transaksi/setor');
    }
    try {
      const trx_no = genTrxNo();
      const cashierId = (req.session.user && req.session.user.id) ? req.session.user.id : null;
      await pool.query('UPDATE santri SET saldo = saldo + ? WHERE id=?', [jml, santri_id]);
      await pool.query(
        'INSERT INTO transaksi (trx_no, santri_id, user_id, tipe, jumlah, keterangan) VALUES (?,?,?,?,?,?)',
        [trx_no, santri_id, cashierId, 'setor', jml, keterangan || null]
      );
      await logAudit(pool, req, { action: 'create', entity: 'transaksi', entity_id: trx_no, details: { tipe: 'setor', santri_id, jumlah: jml } });
      req.session.flash = { type: 'success', message: 'Setoran berhasil dicatat.' };
      res.redirect('/dashboard/kasir');
    } catch (err) {
      console.error(err);
      req.session.flash = { type: 'error', message: 'Gagal mencatat setoran.' };
      return res.redirect('/transaksi/setor');
    }
  });

  // Proses penarikan (TTD fisik setelah dicetak) + PDF
  router.post('/tarik', requireLogin, requireRole('kasir'), async (req, res) => {
    const { santri_id, jumlah, keterangan, nama_penerima } = req.body;
    const jml = parseInt(jumlah, 10);
    if (!santri_id || !jml || jml <= 0) {
      req.session.flash = { type: 'error', message: 'Data tidak lengkap (jumlah).' };
      return res.redirect('/transaksi/tarik');
    }
    if (!canQuery) {
      req.session.flash = { type: 'error', message: 'Database offline; tidak dapat memproses penarikan.' };
      return res.redirect('/transaksi/tarik');
    }
    try {
      const [[santriRow]] = await pool.query('SELECT * FROM santri WHERE id=?', [santri_id]);
      if (!santriRow) {
        req.session.flash = { type: 'error', message: 'Santri tidak ditemukan.' };
        return res.redirect('/transaksi/tarik');
      }
      if (santriRow.saldo < jml) {
        req.session.flash = { type: 'error', message: 'Saldo tidak cukup untuk penarikan.' };
        return res.redirect('/transaksi/tarik');
      }

      const trx_no = genTrxNo();

      // Update saldo & insert transaksi
      const cashierId = (req.session.user && req.session.user.id) ? req.session.user.id : null;
      await pool.query('UPDATE santri SET saldo = saldo - ? WHERE id=?', [jml, santri_id]);
      await pool.query(
        'INSERT INTO transaksi (trx_no, santri_id, user_id, tipe, jumlah, keterangan) VALUES (?,?,?,?,?,?)',
        [trx_no, santri_id, cashierId, 'tarik', jml, keterangan || null]
      );

      // Generate PDF
      const logoPath = process.env.PDF_LOGO_PATH ? path.resolve(process.env.PDF_LOGO_PATH) : null;
      const stampPath = process.env.PDF_STAMP_PATH ? path.resolve(process.env.PDF_STAMP_PATH) : null;

      const pdfPath = await generatePenarikanPDF({
        outputDir: PDF_DIR,
        trx_no,
        santri: santriRow,
        jumlah: jml,
        keterangan,
        kasir: req.session.user.full_name,
        penerima: nama_penerima || santriRow.nama,
        ttdPemberiPath: null,
        ttdPenerimaPath: null,
        logoPath,
        stampPath,
      });

      await pool.query('UPDATE transaksi SET pdf_path=? WHERE trx_no=?', [path.relative(STORAGE_DIR, pdfPath), trx_no]);
      await logAudit(pool, req, { action: 'create', entity: 'transaksi', entity_id: trx_no, details: { tipe: 'tarik', santri_id, jumlah: jml } });

      req.session.flash = { type: 'success', message: 'Penarikan berhasil. PDF bukti dibuat.' };
      res.redirect('/dashboard/kasir');
    } catch (err) {
      console.error(err);
      req.session.flash = { type: 'error', message: 'Gagal memproses penarikan.' };
      return res.redirect('/transaksi/tarik');
    }
  });

  // API pencarian cepat nama santri (autocomplete)
  router.get('/search', requireLogin, requireRole('kasir'), async (req, res) => {
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '12', 10) || 12, 50);
    try {
      let results = [];
      if (!canQuery) {
        return res.json(results);
      }
      if (!q) {
        // Default daftar santri saat q kosong
        const [rows] = await query(
          'SELECT id, nis, nama, kelas, kelompok, foto_path, saldo FROM santri ORDER BY nama ASC LIMIT ?',
          [limit]
        );
        results = rows;
      } else {
        // 1) Prefix match (memanfaatkan index nama)
        const [prefixRows] = await query(
          'SELECT id, nis, nama, kelas, kelompok, foto_path, saldo FROM santri WHERE nama LIKE CONCAT(?, "%") ORDER BY nama ASC LIMIT ?',
          [q, limit]
        );
        results = prefixRows;

        // 2) Tambahan contains match jika hasil sedikit dan query cukup panjang
        if (results.length < limit && q.length >= 3) {
          const [containsRows] = await query(
            'SELECT id, nis, nama, kelas, kelompok, foto_path, saldo FROM santri WHERE nama LIKE ? ORDER BY nama ASC LIMIT ?',
            [`%${q}%`, limit]
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
      }

      res.json(results);
    } catch (err) {
      console.error('Search error:', err);
      res.status(500).json({ error: 'search_failed' });
    }
  });

  // Unduh/lihat PDF bukti penarikan per transaksi
  router.get('/:trxNo/pdf', requireLogin, async (req, res) => {
    try {
      if (!canQuery) {
        req.session.flash = { type: 'error', message: 'Database offline; PDF bukti tidak tersedia.' };
        return res.redirect('/dashboard/kasir');
      }
      const trxNo = req.params.trxNo;
      const [[row]] = await pool.query('SELECT pdf_path FROM transaksi WHERE trx_no=?', [trxNo]);
      if (!row || !row.pdf_path) {
        req.session.flash = { type: 'error', message: 'PDF bukti tidak ditemukan.' };
        return res.redirect('/dashboard/kasir');
      }
      const absPath = path.join(STORAGE_DIR, row.pdf_path);
      if (!fs.existsSync(absPath)) {
        req.session.flash = { type: 'error', message: 'File PDF tidak tersedia.' };
        return res.redirect('/dashboard/kasir');
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${trxNo}.pdf"`);
      return res.sendFile(absPath);
    } catch (err) {
      console.error('PDF serve error:', err);
      req.session.flash = { type: 'error', message: 'Gagal menampilkan PDF.' };
      return res.redirect('/dashboard/kasir');
    }
  });

  // Halaman hapus transaksi (admin)
  router.get('/hapus', requireLogin, requireRole('admin'), async (req, res) => {
    res.render('transaksi_delete', { title: 'Hapus Transaksi' });
  });

  // Proses hapus transaksi (admin)
  router.post('/hapus', requireLogin, requireRole('admin'), async (req, res) => {
    const trxInput = (req.body.trx || '').trim();
    if (!trxInput) {
      req.session.flash = { type: 'error', message: 'Nomor TRX wajib diisi.' };
      return res.redirect('/transaksi/hapus');
    }
    try {
      if (!canQuery) {
        req.session.flash = { type: 'error', message: 'Database offline; penghapusan transaksi tidak tersedia.' };
        return res.redirect('/transaksi/hapus');
      }
      let rows;
      if (/^TRX-\d{8}-\d{6}-[0-9a-f]{8}$/i.test(trxInput)) {
        [rows] = await pool.query('SELECT * FROM transaksi WHERE trx_no=?', [trxInput]);
      } else {
        // Asumsikan input adalah suffix 8 digit (uuid short)
        [rows] = await pool.query('SELECT * FROM transaksi WHERE trx_no LIKE ?', [`%${trxInput}`]);
      }
      if (!rows.length) {
        req.session.flash = { type: 'error', message: 'Transaksi tidak ditemukan.' };
        return res.redirect('/transaksi/hapus');
      }
      if (rows.length > 1) {
        req.session.flash = { type: 'error', message: 'Lebih dari satu hasil. Mohon masukkan nomor lengkap.' };
        return res.redirect('/transaksi/hapus');
      }
      const t = rows[0];

      // Revert saldo sesuai tipe
      if (t.tipe === 'tarik') {
        await pool.query('UPDATE santri SET saldo = saldo + ? WHERE id=?', [t.jumlah, t.santri_id]);
      } else if (t.tipe === 'setor') {
        await pool.query('UPDATE santri SET saldo = saldo - ? WHERE id=?', [t.jumlah, t.santri_id]);
      }

      // Hapus file terkait (pdf/ttd)
      const files = [];
      if (t.pdf_path) files.push(path.join(STORAGE_DIR, t.pdf_path));
      if (t.ttd_pemberi_path) files.push(path.join(STORAGE_DIR, t.ttd_pemberi_path));
      if (t.ttd_penerima_path) files.push(path.join(STORAGE_DIR, t.ttd_penerima_path));
      for (const f of files) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* ignore */ }
      }

      // Hapus transaksi
      await pool.query('DELETE FROM transaksi WHERE trx_no=?', [t.trx_no]);
      await logAudit(pool, req, { action: 'delete', entity: 'transaksi', entity_id: t.trx_no, details: { by: req.session.user.username } });

      req.session.flash = { type: 'success', message: `Transaksi ${t.trx_no} berhasil dihapus dan saldo diperbarui.` };
      return res.redirect('/transaksi/hapus');
    } catch (err) {
      console.error('Delete trx error:', err);
      req.session.flash = { type: 'error', message: 'Gagal menghapus transaksi.' };
      return res.redirect('/transaksi/hapus');
    }
  });

  // --- Admin: Kelola preset nominal ---
  router.get('/presets', requireLogin, requireRole('admin'), async (req, res) => {
    try {
      const [setor] = await query('SELECT * FROM preset_nominal WHERE tipe="setor" ORDER BY sort_order ASC, amount ASC');
      const [tarik] = await query('SELECT * FROM preset_nominal WHERE tipe="tarik" ORDER BY sort_order ASC, amount ASC');
      res.render('presets_nominal', { title: 'Kelola Nominal Preset', presetsSetor: setor, presetsTarik: tarik });
    } catch (err) {
      console.error('Load presets error:', err);
      res.render('presets_nominal', { title: 'Kelola Nominal Preset', presetsSetor: [], presetsTarik: [] });
    }
  });

  router.post('/presets/new', requireLogin, requireRole('admin'), async (req, res) => {
    try {
      if (!canQuery) {
        req.session.flash = { type: 'error', message: 'Database offline; tidak dapat menambah preset.' };
        return res.redirect('/transaksi/presets');
      }
      let { tipe, amount, label, sort_order, active } = req.body;
      tipe = (tipe || '').trim();
      amount = parseInt(amount, 10);
      sort_order = parseInt(sort_order || '0', 10) || 0;
      active = active ? 1 : 0;
      if (!['setor', 'tarik'].includes(tipe) || !amount || amount <= 0) {
        req.session.flash = { type: 'error', message: 'Data preset tidak valid.' };
        return res.redirect('/transaksi/presets');
      }
      await pool.query('INSERT INTO preset_nominal (tipe, amount, label, sort_order, active) VALUES (?,?,?,?,?)', [tipe, amount, label || null, sort_order, active]);
      req.session.flash = { type: 'success', message: 'Preset berhasil ditambahkan.' };
      res.redirect('/transaksi/presets');
    } catch (err) {
      console.error('Add preset error:', err);
      req.session.flash = { type: 'error', message: 'Gagal menambah preset.' };
      res.redirect('/transaksi/presets');
    }
  });

  router.post('/presets/:id/edit', requireLogin, requireRole('admin'), async (req, res) => {
    try {
      if (!canQuery) {
        req.session.flash = { type: 'error', message: 'Database offline; tidak dapat memperbarui preset.' };
        return res.redirect('/transaksi/presets');
      }
      const { id } = req.params;
      let { tipe, amount, label, sort_order, active } = req.body;
      tipe = (tipe || '').trim();
      amount = parseInt(amount, 10);
      sort_order = parseInt(sort_order || '0', 10) || 0;
      active = active ? 1 : 0;
      if (!['setor', 'tarik'].includes(tipe) || !amount || amount <= 0) {
        req.session.flash = { type: 'error', message: 'Data preset tidak valid.' };
        return res.redirect('/transaksi/presets');
      }
      await pool.query('UPDATE preset_nominal SET tipe=?, amount=?, label=?, sort_order=?, active=? WHERE id=?', [tipe, amount, label || null, sort_order, active, id]);
      req.session.flash = { type: 'success', message: 'Preset berhasil diperbarui.' };
      res.redirect('/transaksi/presets');
    } catch (err) {
      console.error('Edit preset error:', err);
      req.session.flash = { type: 'error', message: 'Gagal memperbarui preset.' };
      res.redirect('/transaksi/presets');
    }
  });

  router.post('/presets/:id/delete', requireLogin, requireRole('admin'), async (req, res) => {
    try {
      if (!canQuery) {
        req.session.flash = { type: 'error', message: 'Database offline; tidak dapat menghapus preset.' };
        return res.redirect('/transaksi/presets');
      }
      const { id } = req.params;
      await pool.query('DELETE FROM preset_nominal WHERE id=?', [id]);
      req.session.flash = { type: 'success', message: 'Preset dihapus.' };
      res.redirect('/transaksi/presets');
    } catch (err) {
      console.error('Delete preset error:', err);
      req.session.flash = { type: 'error', message: 'Gagal menghapus preset.' };
      res.redirect('/transaksi/presets');
    }
  });

  return router;
};

function genTrxNo() {
  const dateStr = dayjs().format('YYYYMMDD-HHmmss');
  const short = uuidv4().split('-')[0];
  return `TRX-${dateStr}-${short}`;
}

function saveBase64PNG(dataUrl, filePath) {
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
}