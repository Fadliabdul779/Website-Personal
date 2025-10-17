const express = require('express');
const bcrypt = require('bcryptjs');
const { requireLogin, requireRole } = require('../middleware/auth');

module.exports = function (pool) {
  const router = express.Router();

  // List users (admin only)
  router.get('/', requireLogin, requireRole('admin'), async (req, res) => {
    const [rows] = await pool.query('SELECT id, username, full_name, role, created_at FROM users ORDER BY created_at DESC');
    res.render('users_list', { title: 'Manajemen Pengguna', items: rows });
  });

  // New user form
  router.get('/new', requireLogin, requireRole('admin'), (req, res) => {
    res.render('users_form', { title: 'Tambah Pengguna', item: null });
  });

  // Create user
  router.post('/new', requireLogin, requireRole('admin'), async (req, res) => {
    const { username, full_name, role, password } = req.body;
    if (!username || !full_name || !role || !password) {
      req.session.flash = { type: 'error', message: 'Lengkapi semua field.' };
      return res.redirect('/users/new');
    }
    if (!['admin', 'kasir'].includes(role)) {
      req.session.flash = { type: 'error', message: 'Role tidak valid.' };
      return res.redirect('/users/new');
    }
    try {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)', [username, hash, full_name, role]);
      req.session.flash = { type: 'success', message: 'Pengguna berhasil ditambahkan.' };
      res.redirect('/users');
    } catch (err) {
      console.error(err);
      req.session.flash = { type: 'error', message: 'Gagal menambah pengguna (username mungkin sudah dipakai).' };
      res.redirect('/users/new');
    }
  });

  // Edit form
  router.get('/:id/edit', requireLogin, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT id, username, full_name, role FROM users WHERE id=?', [id]);
    if (!rows.length) {
      req.session.flash = { type: 'error', message: 'Pengguna tidak ditemukan.' };
      return res.redirect('/users');
    }
    res.render('users_form', { title: 'Edit Pengguna', item: rows[0] });
  });

  // Update user (password optional)
  router.post('/:id/edit', requireLogin, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { username, full_name, role, password } = req.body;
    if (!username || !full_name || !role) {
      req.session.flash = { type: 'error', message: 'Username, Nama, dan Role wajib diisi.' };
      return res.redirect(`/users/${id}/edit`);
    }
    if (!['admin', 'kasir'].includes(role)) {
      req.session.flash = { type: 'error', message: 'Role tidak valid.' };
      return res.redirect(`/users/${id}/edit`);
    }
    try {
      if (password && password.trim()) {
        const hash = await bcrypt.hash(password.trim(), 10);
        await pool.query('UPDATE users SET username=?, full_name=?, role=?, password_hash=? WHERE id=?', [username, full_name, role, hash, id]);
      } else {
        await pool.query('UPDATE users SET username=?, full_name=?, role=? WHERE id=?', [username, full_name, role, id]);
      }
      req.session.flash = { type: 'success', message: 'Pengguna berhasil diperbarui.' };
      res.redirect('/users');
    } catch (err) {
      console.error(err);
      req.session.flash = { type: 'error', message: 'Gagal memperbarui pengguna.' };
      res.redirect(`/users/${id}/edit`);
    }
  });

  // Delete user (prevent delete self)
  router.post('/:id/delete', requireLogin, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    if (parseInt(id, 10) === req.session.user.id) {
      req.session.flash = { type: 'error', message: 'Anda tidak dapat menghapus akun sendiri.' };
      return res.redirect('/users');
    }
    try {
      await pool.query('DELETE FROM users WHERE id=?', [id]);
      req.session.flash = { type: 'success', message: 'Pengguna berhasil dihapus.' };
      res.redirect('/users');
    } catch (err) {
      console.error(err);
      req.session.flash = { type: 'error', message: 'Gagal menghapus pengguna.' };
      res.redirect('/users');
    }
  });

  return router;
};