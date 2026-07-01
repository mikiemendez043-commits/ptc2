function requireStaffAuth(req, res, next) {
  if (req.session && req.session.isStaff) {
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated. Please log in as staff.' });
}

module.exports = { requireStaffAuth };
