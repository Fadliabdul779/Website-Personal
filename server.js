const path = require('path');
const fs = require('fs');
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const csrf = require('csurf');
const dayjs = require('dayjs');

// Ensure storage directories exist
const STORAGE_DIR = path.join(__dirname, 'storage');
const PDF_DIR = path.join(STORAGE_DIR, 'pdfs');
const SIGN_DIR = path.join(STORAGE_DIR, 'signatures');
const FOTO_DIR = path.join(__dirname, 'public', 'uploads', 'fotos');
[STORAGE_DIR, PDF_DIR, SIGN_DIR, FOTO_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// DB config
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASS = process.env.DB_PASS || '';
const DB_NAME = process.env.DB_NAME || 'tabungan_santri';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);

const mysql = require('mysql2/promise');
let pool; // mysql pool

async function initDatabase() {
  // create database if not exists (skip errors on hosted MySQL without CREATE privilege)
  try {
    const conn = await mysql.createConnection({ host: DB_HOST, user: DB_USER, password: DB_PASS, port: DB_PORT });
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
    await conn.end();
  } catch (e) {
    console.warn('Skip CREATE DATABASE step:', e.message);
  }

  pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    port: DB_PORT,
    connectionLimit: 10,
  });

  // migrate tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(200) NOT NULL,
      role VARCHAR(20) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS santri (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nis VARCHAR(50) UNIQUE NOT NULL,
      nama VARCHAR(200) NOT NULL,
      kelas VARCHAR(50),
      kelompok VARCHAR(100),
      tgl_lahir DATE,
      alamat TEXT,
      hp_wali VARCHAR(30),
      foto_path VARCHAR(255),
      saldo BIGINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);
  // Tambahkan index untuk mempercepat pencarian nama santri
  try {
    const [idxRows] = await pool.query("SHOW INDEX FROM santri WHERE Key_name='idx_santri_nama'");
    if (!idxRows.length) {
      await pool.query('ALTER TABLE santri ADD INDEX idx_santri_nama (nama)');
      console.log('Index idx_santri_nama ditambahkan pada tabel santri.');
    }
  } catch (e) {
    console.warn('Gagal memeriksa/menambah index santri.nama:', e.message);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transaksi (
      id INT AUTO_INCREMENT PRIMARY KEY,
      trx_no VARCHAR(50) UNIQUE NOT NULL,
      santri_id INT,
      user_id INT,
      tipe VARCHAR(10) NOT NULL,
      jumlah BIGINT NOT NULL,
      keterangan TEXT,
      ttd_pemberi_path VARCHAR(255),
      ttd_penerima_path VARCHAR(255),
      pdf_path VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (santri_id) REFERENCES santri(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      action VARCHAR(100) NOT NULL,
      entity VARCHAR(100) NOT NULL,
      entity_id VARCHAR(100),
      details TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB;
  `);

  // Preset nominal (untuk pilihan cepat setoran/penarikan)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preset_nominal (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tipe VARCHAR(10) NOT NULL,
      amount BIGINT NOT NULL,
      label VARCHAR(100),
      sort_order INT DEFAULT 0,
      active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);

  // Feedback/Saran (arsip masukan pengguna)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nama VARCHAR(100),
      pesan TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP NULL,
      deleted_by INT NULL,
      FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB;
  `);

  // Seed default preset jika kosong
  const [[{ cnt_preset }]] = await pool.query('SELECT COUNT(*) AS cnt_preset FROM preset_nominal');
  if (cnt_preset === 0) {
    const base = [10000, 20000, 50000, 100000];
    const values = [];
    base.forEach((amt, idx) => {
      values.push(['setor', amt, `${(amt/1000)} rb`, idx + 1, 1]);
    });
    base.forEach((amt, idx) => {
      values.push(['tarik', amt, `${(amt/1000)} rb`, idx + 1, 1]);
    });
    await pool.query(
      'INSERT INTO preset_nominal (tipe, amount, label, sort_order, active) VALUES ' +
      values.map(() => '(?,?,?,?,?)').join(','),
      values.flat()
    );
    console.log('Seeded default preset nominal (10k, 20k, 50k, 100k) untuk setor/tarik');
  }

  // seed admin & kasir if not exists
  const [rows] = await pool.query('SELECT COUNT(*) as cnt FROM users');
  if (rows[0].cnt === 0) {
    const bcrypt = require('bcryptjs');
    const adminPass = await bcrypt.hash('admin123', 10);
    const kasirPass = await bcrypt.hash('kasir123', 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      ['admin', adminPass, 'Admin Utama', 'admin', 'kasir', kasirPass, 'Kasir Utama', 'kasir']
    );
    console.log('Seeded default users: admin/admin123, kasir/kasir123');
  }

  return pool;
}

const app = express();

// Helmet security headers
app.use(helmet({
  contentSecurityPolicy: false,
}));

// Static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// Body parser
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));

// View engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
const expressLayouts = require('express-ejs-layouts');
app.use(expressLayouts);
app.set('layout', 'layout');

let sessionStore;

async function bootstrap() {
  let dbReady = true;
  try {
    await initDatabase();
  } catch (err) {
    console.error('Inisialisasi database gagal. Menjalankan server dalam mode degradasi untuk preview UI.', err.message || err);
    dbReady = false;
  }

  // Session store in MySQL
  if (dbReady) {
    sessionStore = new MySQLStore({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS,
      database: DB_NAME,
      clearExpired: true,
      checkExpirationInterval: 900000, // 15 minutes
      expiration: 86400000, // 1 day,
    });
  } else {
    // Fallback ke MemoryStore agar halaman bisa dipreview tanpa DB
    sessionStore = new session.MemoryStore();
  }

  app.use(session({
    secret: process.env.SESSION_SECRET || 'tabungan-santri-secret',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 86400000,
    },
  }));

  // Dev helper: lewati login saat preview UI jika DEV_SKIP_AUTH=1
  if (process.env.DEV_SKIP_AUTH === '1') {
    app.use((req, res, next) => {
      // Jangan injeksi sesi dev untuk halaman login/logout agar login tetap tampil
      if (req.path.startsWith('/login') || req.path.startsWith('/logout')) {
        return next();
      }
      if (!req.session.user) {
        const previewRole = process.env.DEV_PREVIEW_ROLE || 'kasir';
        req.session.user = { id: 0, username: 'dev', full_name: 'Developer', role: previewRole };
      }
      next();
    });
  }

  // CSRF protection (use after session)
  app.use(csrf());

  // Simple flash messages using session and expose csrf token
  app.use((req, res, next) => {
    res.locals.csrfToken = req.csrfToken();
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.user = req.session.user || null;
    res.locals.currentPath = req.path;
    res.locals.currentUrl = req.originalUrl;
    // Expose DB status and preview mode to views
    res.locals.dbReady = !!(pool && typeof pool.query === 'function');
    res.locals.previewMode = process.env.DEV_SKIP_AUTH === '1';
    next();
  });

  // Routes
  const authRouter = require('./src/routes/auth')(pool);
  const feedbackRouter = require('./src/routes/feedback')(pool);
  const dashboardRouter = require('./src/routes/dashboard')(pool);
  const santriRouter = require('./src/routes/santri')(pool);
  const transaksiRouter = require('./src/routes/transaksi')(pool);
  const usersRouter = require('./src/routes/users')(pool);
  const accountRouter = require('./src/routes/account')(pool);
  const laporanRouter = require('./src/routes/laporan')(pool);

  app.use('/', authRouter);
  app.use('/feedback', feedbackRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/santri', santriRouter);
  app.use('/transaksi', transaksiRouter);
  app.use('/users', usersRouter);
  app.use('/account', accountRouter);
  app.use('/laporan', laporanRouter);

  // Root redirect
  app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const role = req.session.user.role;
    return res.redirect(role === 'admin' ? '/dashboard/admin' : '/dashboard/kasir');
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Tabungan Santri server berjalan di http://localhost:${PORT}`);
  });
}
bootstrap().catch((err) => {
  console.error('Bootstrap error:', err);
  // Jangan exit agar environment tetap hidup; log saja.
});