async function logAudit(pool, req, { action, entity, entity_id = null, details = null }) {
  try {
    const userId = req?.session?.user?.id || null;
    const payload = typeof details === 'object' ? JSON.stringify(details) : (details || null);
    await pool.query(
      'INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)',
      [userId, action, entity, entity_id, payload]
    );
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

module.exports = { logAudit };