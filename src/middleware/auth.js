function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.flash = { type: 'error', message: 'Silakan login terlebih dahulu.' };
    return res.redirect('/login');
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      req.session.flash = { type: 'error', message: 'Akses ditolak.' };
      return res.redirect('/login');
    }
    next();
  };
}

function requireRoles(roles){
  return (req, res, next) => {
    const user = req.session.user;
    if (!user || !roles.includes(user.role)){
      req.session.flash = { type: 'error', message: 'Akses ditolak.' };
      return res.redirect('/login');
    }
    next();
  };
}

module.exports = { requireLogin, requireRole, requireRoles };