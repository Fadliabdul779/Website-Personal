const express = require('express');
const { requireLogin, requireRole } = require('../middleware/auth');
const dayjs = require('dayjs');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

module.exports = function (pool) {
  const router = express.Router();
  const canQuery = !!(pool && typeof pool.query === 'function');

  router.get('/', requireLogin, requireRole('admin'), async (req, res) => {
    const { start, end, range } = req.query;
    let startDate;
    let endDate;

    if (range === 'day') {
      startDate = dayjs().format('YYYY-MM-DD');
      endDate = startDate;
    } else if (range === 'week') {
      // 7 hari terakhir (termasuk hari ini)
      startDate = dayjs().subtract(6, 'day').format('YYYY-MM-DD');
      endDate = dayjs().format('YYYY-MM-DD');
    } else if (range === 'month') {
      startDate = dayjs().startOf('month').format('YYYY-MM-DD');
      endDate = dayjs().endOf('month').format('YYYY-MM-DD');
    } else {
      startDate = start || dayjs().format('YYYY-MM-DD');
      endDate = end || dayjs().format('YYYY-MM-DD');
    }
    try {
      if (!canQuery) {
        req.session.flash = { type: 'error', message: 'Database offline; laporan tidak tersedia.' };
        return res.render('laporan', { title: 'Laporan Transaksi', rows: [], startDate, endDate, totalSetor: 0, totalTarik: 0 });
      }
      const [rows] = await pool.query(
        `SELECT t.*, s.nis, s.nama, u.full_name AS kasir_name
         FROM transaksi t
         JOIN santri s ON t.santri_id=s.id
         LEFT JOIN users u ON t.user_id=u.id
         WHERE DATE(t.created_at) BETWEEN ? AND ?
         ORDER BY t.created_at DESC`,
        [startDate, endDate]
      );
      const totalSetor = rows.filter(r => r.tipe==='setor').reduce((a,b)=>a+b.jumlah,0);
      const totalTarik = rows.filter(r => r.tipe==='tarik').reduce((a,b)=>a+b.jumlah,0);
      res.render('laporan', { title: 'Laporan Transaksi', rows, startDate, endDate, totalSetor, totalTarik });
    } catch (err) {
      console.error('laporan list error:', err);
      req.session.flash = { type: 'error', message: 'Gagal memuat laporan.' };
      res.render('laporan', { title: 'Laporan Transaksi', rows: [], startDate, endDate, totalSetor: 0, totalTarik: 0 });
    }
  });

  router.get('/export/csv', requireLogin, requireRole('admin'), async (req, res) => {
    const { start, end } = req.query;
    const startDate = start || dayjs().format('YYYY-MM-DD');
    const endDate = end || dayjs().format('YYYY-MM-DD');
    if (!canQuery) {
      req.session.flash = { type: 'error', message: 'Database offline; export CSV tidak tersedia.' };
      return res.redirect(`/laporan?start=${startDate}&end=${endDate}`);
    }
    const [rows] = await pool.query(
      `SELECT t.trx_no, t.tipe, t.jumlah, t.keterangan, t.created_at, s.nis, s.nama, u.full_name AS kasir_name
       FROM transaksi t
       JOIN santri s ON t.santri_id=s.id
       LEFT JOIN users u ON t.user_id=u.id
       WHERE DATE(t.created_at) BETWEEN ? AND ?
       ORDER BY t.created_at ASC`,
      [startDate, endDate]
    );
    const headers = ['Tanggal', 'Nomor', 'NIS', 'Nama', 'Tipe', 'Jumlah', 'Kasir', 'Keterangan'];
    const csv = [headers.join(',')].concat(rows.map(r => [
      dayjs(r.created_at).format('YYYY-MM-DD HH:mm:ss'), r.trx_no, r.nis, r.nama, r.tipe, r.jumlah, (r.kasir_name||''), (r.keterangan||'')
    ].map(val => String(val).replace(/,/g,';')).join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="laporan_${startDate}_${endDate}.csv"`);
    res.send(csv);
  });

  router.get('/export/pdf', requireLogin, requireRole('admin'), async (req, res) => {
    const { start, end } = req.query;
    if (!canQuery) {
      const startDate = start || dayjs().format('YYYY-MM-DD');
      const endDate = end || dayjs().format('YYYY-MM-DD');
      req.session.flash = { type: 'error', message: 'Database offline; export PDF tidak tersedia.' };
      return res.redirect(`/laporan?start=${startDate}&end=${endDate}`);
    }
    const startDate = start || dayjs().format('YYYY-MM-DD');
    const endDate = end || dayjs().format('YYYY-MM-DD');
    const [rows] = await pool.query(
      `SELECT t.trx_no, t.tipe, t.jumlah, t.keterangan, t.created_at, s.nis, s.nama, u.full_name AS kasir_name
       FROM transaksi t
       JOIN santri s ON t.santri_id=s.id
       LEFT JOIN users u ON t.user_id=u.id
       WHERE DATE(t.created_at) BETWEEN ? AND ?
       ORDER BY t.created_at ASC`,
      [startDate, endDate]
    );

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="laporan_${startDate}_${endDate}.pdf"`);
    doc.pipe(res);
    doc.fontSize(16).text('LAPORAN TRANSAKSI TABUNGAN SANTRI', { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).text(`Periode: ${dayjs(startDate).format('DD MMM YYYY')} s.d. ${dayjs(endDate).format('DD MMM YYYY')}`);
    doc.moveDown();
    let totalSetor = 0, totalTarik = 0;
    rows.forEach(r => { if (r.tipe==='setor') totalSetor += r.jumlah; else totalTarik += r.jumlah; });
    doc.text(`Total Setoran: Rp ${formatRupiah(totalSetor)}`);
    doc.text(`Total Penarikan: Rp ${formatRupiah(totalTarik)}`);
    doc.moveDown();
    doc.fontSize(11).text('Rincian:');
    doc.moveDown(0.5);
    rows.forEach(r => {
      doc.text(`${dayjs(r.created_at).format('DD/MM HH:mm')} | ${r.trx_no} | ${r.nis} - ${r.nama} | ${r.tipe} | Rp ${formatRupiah(r.jumlah)} | ${r.kasir_name || ''}`);
    });
    doc.end();
  });

  return router;
};

function formatRupiah(n){ return (n||0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }