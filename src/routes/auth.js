const express = require('express');
const bcrypt = require('bcryptjs');

module.exports = function (pool) {
  const router = express.Router();
  const { logAudit } = require('../utils/audit');
  const canQuery = !!(pool && typeof pool.query === 'function');

  router.get('/login', (req, res) => {
    if (req.session.user) {
      const role = req.session.user.role;
      return res.redirect(role === 'admin' ? '/dashboard/admin' : '/dashboard/kasir');
    }
    // Arsip feedback hanya untuk admin (melalui /feedback).
    // Halaman login tidak lagi memuat arsip agar publik tidak melihatnya.
    res.render('login', { title: 'Login', csrfToken: req.csrfToken() });
  });

  router.post('/login', async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
      req.session.flash = { type: 'error', message: 'Lengkapi username, password, dan role.' };
      return res.redirect('/login');
    }
    if (!canQuery) {
      req.session.flash = { type: 'error', message: 'Database offline; login dinonaktifkan untuk keamanan. Aktifkan database untuk masuk.' };
      return res.redirect('/login');
    }
    try {
      const [users] = await pool.query('SELECT * FROM users WHERE username = ? AND role = ?', [username, role]);
      if (!users.length) {
        req.session.flash = { type: 'error', message: 'Akun tidak ditemukan atau role salah.' };
        return res.redirect('/login');
      }
      const user = users[0];
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        req.session.flash = { type: 'error', message: 'Password salah.' };
        return res.redirect('/login');
      }
      req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
      await logAudit(pool, req, { action: 'login', entity: 'auth', entity_id: user.id.toString(), details: { username: user.username, role: user.role } });
      return res.redirect(user.role === 'admin' ? '/dashboard/admin' : '/dashboard/kasir');
    } catch (err) {
      console.error(err);
      req.session.flash = { type: 'error', message: 'Terjadi kesalahan saat login.' };
      return res.redirect('/login');
    }
  });

  router.get('/logout', (req, res) => {
    const user = req.session.user;
    req.session.destroy(async () => {
      try {
        await logAudit(pool, { session: { user } }, { action: 'logout', entity: 'auth', entity_id: user?.id?.toString() || null });
      } catch (e) {}
      res.redirect('/login');
    });
  });

  return router;
};