const express = require('express');
const { requireLogin, requireRole } = require('../middleware/auth');
const dayjs = require('dayjs');

module.exports = function (pool) {
  const router = express.Router();

  router.get('/admin', requireLogin, requireRole('admin'), async (req, res) => {
    try {
      const [[{ total_saldo }]] = await pool.query('SELECT COALESCE(SUM(saldo),0) AS total_saldo FROM santri');
      const [[{ santri_count }]] = await pool.query('SELECT COUNT(*) AS santri_count FROM santri');
      const [[{ kasir_count }]] = await pool.query("SELECT COUNT(*) AS kasir_count FROM users WHERE role='kasir'");
      const today = dayjs().format('YYYY-MM-DD');
      const [[setorToday]] = await pool.query(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(jumlah),0) AS total FROM transaksi WHERE tipe='setor' AND DATE(created_at)=?",
        [today]
      );
      const [[tarikToday]] = await pool.query(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(jumlah),0) AS total FROM transaksi WHERE tipe='tarik' AND DATE(created_at)=?",
        [today]
      );

      // Ringkasan Mingguan (7 hari terakhir termasuk hari ini)
      const weekStart = dayjs().subtract(6, 'day').format('YYYY-MM-DD');
      const weekEnd = dayjs().format('YYYY-MM-DD');
      const [[setorWeek]] = await pool.query(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(jumlah),0) AS total FROM transaksi WHERE tipe='setor' AND DATE(created_at) BETWEEN ? AND ?",
        [weekStart, weekEnd]
      );
      const [[tarikWeek]] = await pool.query(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(jumlah),0) AS total FROM transaksi WHERE tipe='tarik' AND DATE(created_at) BETWEEN ? AND ?",
        [weekStart, weekEnd]
      );

      // Ringkasan Bulanan (bulan berjalan)
      const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
      const monthEnd = dayjs().endOf('month').format('YYYY-MM-DD');
      const [[setorMonth]] = await pool.query(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(jumlah),0) AS total FROM transaksi WHERE tipe='setor' AND DATE(created_at) BETWEEN ? AND ?",
        [monthStart, monthEnd]
      );
      const [[tarikMonth]] = await pool.query(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(jumlah),0) AS total FROM transaksi WHERE tipe='tarik' AND DATE(created_at) BETWEEN ? AND ?",
        [monthStart, monthEnd]
      );
      res.render('dashboard_admin', {
        title: 'Dashboard Admin',
        totalSaldo: total_saldo,
        santriCount: santri_count,
        kasirCount: kasir_count,
        todayDate: today,
        todaySetorCount: setorToday.cnt || 0,
        todaySetorTotal: setorToday.total || 0,
        todayTarikCount: tarikToday.cnt || 0,
        todayTarikTotal: tarikToday.total || 0,
        weekStart,
        weekEnd,
        weekSetorCount: setorWeek.cnt || 0,
        weekSetorTotal: setorWeek.total || 0,
        weekTarikCount: tarikWeek.cnt || 0,
        weekTarikTotal: tarikWeek.total || 0,
        monthStart,
        monthEnd,
        monthSetorCount: setorMonth.cnt || 0,
        monthSetorTotal: setorMonth.total || 0,
        monthTarikCount: tarikMonth.cnt || 0,
        monthTarikTotal: tarikMonth.total || 0,
      });
    } catch (err) {
      console.error(err);
      res.render('dashboard_admin', {
        title: 'Dashboard Admin',
        totalSaldo: 0,
        santriCount: 0,
        kasirCount: 0,
        todayDate: dayjs().format('YYYY-MM-DD'),
        todaySetorCount: 0,
        todaySetorTotal: 0,
        todayTarikCount: 0,
        todayTarikTotal: 0,
        weekStart: dayjs().subtract(6, 'day').format('YYYY-MM-DD'),
        weekEnd: dayjs().format('YYYY-MM-DD'),
        weekSetorCount: 0,
        weekSetorTotal: 0,
        weekTarikCount: 0,
        weekTarikTotal: 0,
        monthStart: dayjs().startOf('month').format('YYYY-MM-DD'),
        monthEnd: dayjs().endOf('month').format('YYYY-MM-DD'),
        monthSetorCount: 0,
        monthSetorTotal: 0,
        monthTarikCount: 0,
        monthTarikTotal: 0,
      });
    }
  });

  router.get('/kasir', requireLogin, requireRole('kasir'), async (req, res) => {
    const { start, end, range } = req.query;
    let filterStart = null;
    let filterEnd = null;

    // Hitung rentang preset jika ada
    if (range === 'day') {
      filterStart = dayjs().format('YYYY-MM-DD');
      filterEnd = filterStart;
    } else if (range === 'week') {
      filterStart = dayjs().subtract(6, 'day').format('YYYY-MM-DD');
      filterEnd = dayjs().format('YYYY-MM-DD');
    } else if (range === 'month') {
      filterStart = dayjs().startOf('month').format('YYYY-MM-DD');
      filterEnd = dayjs().endOf('month').format('YYYY-MM-DD');
    }

    // Override dengan start/end eksplisit jika valid
    if (start && dayjs(start).isValid()) filterStart = dayjs(start).format('YYYY-MM-DD');
    if (end && dayjs(end).isValid()) filterEnd = dayjs(end).format('YYYY-MM-DD');

    try {
      let trx;
      if (filterStart && filterEnd) {
        const [rows] = await pool.query(
          "SELECT t.*, s.nis, s.nama FROM transaksi t JOIN santri s ON t.santri_id=s.id WHERE DATE(t.created_at) BETWEEN ? AND ? ORDER BY t.created_at DESC",
          [filterStart, filterEnd]
        );
        trx = rows;
      } else {
        const today = dayjs().format('YYYY-MM-DD');
        const [rows] = await pool.query(
          "SELECT t.*, s.nis, s.nama FROM transaksi t JOIN santri s ON t.santri_id=s.id WHERE DATE(t.created_at)=? ORDER BY t.created_at DESC",
          [today]
        );
        trx = rows;
      }
      res.render('dashboard_kasir', { title: 'Dashboard Kasir', transaksi: trx, filterStart, filterEnd });
    } catch (err) {
      console.error(err);
      // Tetap kirimkan nilai filter agar UI bisa menampilkan preset/rentang di mode offline
      res.render('dashboard_kasir', { title: 'Dashboard Kasir', transaksi: [], filterStart, filterEnd });
    }
  });

  // API: Ringkasan harian pemasukan/pengeluaran untuk chart
  router.get('/api/daily', requireLogin, async (req, res) => {
    try {
      const { start, end, range } = req.query;
      let startDate = null;
      let endDate = null;
      if (range === 'day') {
        startDate = dayjs().format('YYYY-MM-DD');
        endDate = startDate;
      } else if (range === 'week') {
        startDate = dayjs().subtract(6, 'day').format('YYYY-MM-DD');
        endDate = dayjs().format('YYYY-MM-DD');
      } else if (range === 'month') {
        startDate = dayjs().startOf('month').format('YYYY-MM-DD');
        endDate = dayjs().endOf('month').format('YYYY-MM-DD');
      }

      // Override jika start/end eksplisit valid
      if (start && dayjs(start).isValid()) startDate = dayjs(start).format('YYYY-MM-DD');
      if (end && dayjs(end).isValid()) endDate = dayjs(end).format('YYYY-MM-DD');

      let labels = [];
      let rows;
      if (startDate && endDate) {
        const spanDays = Math.min(Math.max(dayjs(endDate).diff(dayjs(startDate), 'day') + 1, 1), 180);
        [rows] = await pool.query(
          'SELECT DATE(created_at) AS d, tipe, SUM(jumlah) AS total FROM transaksi WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY d, tipe ORDER BY d ASC',
          [startDate, endDate]
        );
        for (let i = 0; i < spanDays; i++) {
          labels.push(dayjs(startDate).add(i, 'day').format('YYYY-MM-DD'));
        }
      } else {
        const days = Math.min(parseInt(req.query.days || '14', 10) || 14, 90);
        startDate = dayjs().subtract(days - 1, 'day').format('YYYY-MM-DD');
        [rows] = await pool.query(
          'SELECT DATE(created_at) AS d, tipe, SUM(jumlah) AS total FROM transaksi WHERE DATE(created_at) >= ? GROUP BY d, tipe ORDER BY d ASC',
          [startDate]
        );
        for (let i = 0; i < days; i++) {
          labels.push(dayjs(startDate).add(i, 'day').format('YYYY-MM-DD'));
        }
      }
      const masukMap = new Map();
      const keluarMap = new Map();
      for (const r of rows) {
        const key = dayjs(r.d).format('YYYY-MM-DD');
        if (r.tipe === 'setor') masukMap.set(key, Number(r.total) || 0);
        else if (r.tipe === 'tarik') keluarMap.set(key, Number(r.total) || 0);
      }
      const pemasukan = labels.map(d => masukMap.get(d) || 0);
      const pengeluaran = labels.map(d => keluarMap.get(d) || 0);
      res.json({ labels, pemasukan, pengeluaran });
    } catch (err) {
      console.error('daily stats error:', err);
      res.status(500).json({ error: 'stats_failed' });
    }
  });

  return router;
};