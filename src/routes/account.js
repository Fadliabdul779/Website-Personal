const express = require('express');
const bcrypt = require('bcryptjs');
const { requireLogin } = require('../middleware/auth');

module.exports = function (pool) {
  const router = express.Router();

  // View account settings
  router.get('/', requireLogin, async (req, res) => {
    const [rows] = await pool.query('SELECT id, username, full_name, role FROM users WHERE id=?', [req.session.user.id]);
    res.render('account', { title: 'Pengaturan Akun', me: rows[0] });
  });

  // Update name or password
  router.post('/', requireLogin, async (req, res) => {
    const { full_name, password } = req.body;
    try {
      if (password && password.trim()) {
        const hash = await bcrypt.hash(password.trim(), 10);
        await pool.query('UPDATE users SET full_name=?, password_hash=? WHERE id=?', [full_name || req.session.user.full_name, hash, req.session.user.id]);
      } else {
        await pool.query('UPDATE users SET full_name=? WHERE id=?', [full_name || req.session.user.full_name, req.session.user.id]);
      }
      // refresh session name
      req.session.user.full_name = full_name || req.session.user.full_name;
      req.session.flash = { type: 'success', message: 'Akun berhasil diperbarui.' };
      res.redirect('/account');
    } catch (err) {
      console.error(err);
      req.session.flash = { type: 'error', message: 'Gagal memperbarui akun.' };
      res.redirect('/account');
    }
  });

  return router;
};