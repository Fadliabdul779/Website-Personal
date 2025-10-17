const express = require('express');
const { requireRole, requireRoles } = require('../middleware/auth');

module.exports = function (pool) {
  const router = express.Router();

  // Submit feedback (public, requires CSRF)
  router.post('/', async (req, res) => {
    const { nama, pesan } = req.body || {};
    if (!pesan || !pesan.trim()) {
      req.session.flash = { type: 'error', message: 'Masukan tidak boleh kosong.' };
      return res.redirect('/login');
    }
    try {
      await pool.query('INSERT INTO feedback (nama, pesan) VALUES (?, ?)', [nama || null, pesan.trim()]);
      req.session.flash = { type: 'success', message: 'Terima kasih, masukan Anda telah dikirim.' };
    } catch (e) {
      console.error('submit feedback error', e);
      req.session.flash = { type: 'error', message: 'Gagal mengirim masukan.' };
    }
    return res.redirect('/login');
  });

  // View feedback archive (admin & kasir). Kasir hanya baca, admin bisa hapus.
  router.get('/', requireRoles(['admin','kasir']), async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM feedback WHERE deleted_at IS NULL ORDER BY created_at DESC');
      res.render('feedback_list', { title: 'Arsip Masukan', items: rows });
    } catch (e) {
      console.error('list feedback error', e);
      req.session.flash = { type: 'error', message: 'Gagal memuat arsip masukan.' };
      const role = req.session.user?.role;
      res.redirect(role === 'kasir' ? '/dashboard/kasir' : '/dashboard/admin');
    }
  });

  // Admin delete feedback (soft delete)
  router.post('/:id/delete', requireRole('admin'), async (req, res) => {
    const id = Number(req.params.id);
    if (!id) { return res.redirect('/feedback'); }
    try {
      await pool.query('UPDATE feedback SET deleted_at = NOW(), deleted_by = ? WHERE id = ?', [req.session.user.id, id]);
      req.session.flash = { type: 'success', message: 'Masukan dihapus.' };
    } catch (e) {
      console.error('delete feedback error', e);
      req.session.flash = { type: 'error', message: 'Gagal menghapus masukan.' };
    }
    return res.redirect('/feedback');
  });

  return router;
};