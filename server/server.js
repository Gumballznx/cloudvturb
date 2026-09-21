process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err ? err.message : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, execFileSync, spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const geoip = require('geoip-lite');

[path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')].forEach(envPath => {
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!(key in process.env)) {
          process.env[key] = val;
        }
      }
    }
  }
});

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const isInsecureSecret = !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.trim() === '' ||
  process.env.JWT_SECRET === 'cloudvturb_ultra_secret_key_2026_jwt_token_99' ||
  process.env.JWT_SECRET === 'cloudvturb_dev_secret_key_2026';

if (NODE_ENV === 'production' && isInsecureSecret) {
  console.error('ERRO FATAL: JWT_SECRET seguro deve ser configurado via variável de ambiente em produção.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'cloudvturb_dev_secret_key_2026';

const SERVER_STORAGE_LIMIT_BYTES = 30 * 1024 * 1024 * 1024;
const MEMBER_STORAGE_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_STORAGE_BYTES = SERVER_STORAGE_LIMIT_BYTES;
const APP_NAME = process.env.APP_NAME || 'CloudVTurb';
const BASE_DOMAIN = (process.env.BASE_DOMAIN || '').toLowerCase();
const PLAYER_DOMAIN = (process.env.PLAYER_DOMAIN || (BASE_DOMAIN ? `player.${BASE_DOMAIN}` : '')).toLowerCase();
const DASH_DOMAIN = (process.env.DASH_DOMAIN || (BASE_DOMAIN ? `dash.${BASE_DOMAIN}` : '')).toLowerCase();
const HELP_DOMAIN = (process.env.HELP_DOMAIN || (BASE_DOMAIN ? `help.${BASE_DOMAIN}` : '')).toLowerCase();

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync(path.join(__dirname, 'data')) ? path.join(__dirname, 'data') : path.join(process.cwd(), 'data'));
const VIDEOS_DIR = process.env.VIDEOS_DIR || (fs.existsSync(path.join(__dirname, 'videos')) ? path.join(__dirname, 'videos') : path.join(process.cwd(), 'videos'));
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cloudvturb.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    status TEXT DEFAULT 'pending',
    full_name TEXT,
    country TEXT,
    phone TEXT,
    address_street TEXT,
    postal_code TEXT,
    state_province TEXT,
    onboarding_completed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    folder_id TEXT,
    title TEXT NOT NULL,
    source_type TEXT DEFAULT 'remote',
    file_path TEXT,
    video_url TEXT NOT NULL,
    duration TEXT DEFAULT NULL,
    file_size INTEGER DEFAULT 0,
    plays INTEGER DEFAULT 0,
    settings_json TEXT,
    status TEXT DEFAULT 'ready',
    optimization_progress INTEGER DEFAULT 0,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    milestone INTEGER,
    watch_time REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    events_json TEXT NOT NULL,
    secret TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status_code INTEGER,
    response_body TEXT,
    success INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comparison_groups (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    started_at DATETIME,
    finished_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comparison_group_players (
    id TEXT PRIMARY KEY,
    comparison_group_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    traffic_percentage REAL DEFAULT 50,
    started_at DATETIME,
    locked INTEGER DEFAULT 0,
    FOREIGN KEY(comparison_group_id) REFERENCES comparison_groups(id) ON DELETE CASCADE,
    FOREIGN KEY(player_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS custom_metrics (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    time INTEGER NOT NULL,
    sequential_number INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_quota_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    queries_count INTEGER DEFAULT 1,
    read_bytes INTEGER DEFAULT 1024
  );

  CREATE TABLE IF NOT EXISTS verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT,
    attempts INTEGER DEFAULT 0,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    accepted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS allowed_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    domain TEXT NOT NULL,
    traffic_count INTEGER DEFAULT 0,
    last_session_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_verification_email_type ON verification_codes(email, type);
  CREATE INDEX IF NOT EXISTS idx_team_invites_owner ON team_invites(owner_id);
  CREATE INDEX IF NOT EXISTS idx_team_invites_token ON team_invites(token);
  CREATE INDEX IF NOT EXISTS idx_allowed_domains_user ON allowed_domains(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, read);
  CREATE INDEX IF NOT EXISTS idx_analytics_vid_event ON analytics_events(video_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_analytics_vid_created ON analytics_events(video_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_analytics_vid_visitor ON analytics_events(video_id, visitor_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_session_milestone ON analytics_events(session_id, event_type, milestone);
`);


const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

try {
  const legacyAvatars = path.join(PUBLIC_DIR, 'avatars');
  if (fs.existsSync(legacyAvatars)) {
    const files = fs.readdirSync(legacyAvatars);
    for (const f of files) {
      const src = path.join(legacyAvatars, f);
      const dst = path.join(AVATARS_DIR, f);
      if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
  }
} catch (e) {}

const userCols = ['full_name', 'country', 'phone', 'address_street', 'postal_code', 'state_province', 'avatar_url', 'first_name', 'last_name'];
for (const col of userCols) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`); } catch (e) {}
}
try { db.exec('ALTER TABLE users ADD COLUMN owner_id INTEGER DEFAULT NULL'); } catch (e) {}

const securityCols = [
  'google_connected INTEGER DEFAULT 0',
  'google_email TEXT DEFAULT NULL',
  'two_factor_enabled INTEGER DEFAULT 0',
  'two_factor_secret TEXT DEFAULT NULL',
  'two_factor_temp_secret TEXT DEFAULT NULL',
  'require_member_2fa INTEGER DEFAULT 0',
  'token_version INTEGER DEFAULT 1'
];
for (const colDef of securityCols) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${colDef}`); } catch (e) {}
}

const analyticsCols = [
  'device TEXT DEFAULT "desktop"',
  'browser TEXT DEFAULT "Chrome"',
  'os TEXT DEFAULT "Windows"',
  'country TEXT DEFAULT "Mozambique"',
  'domain TEXT',
  'utm_source TEXT',
  'utm_medium TEXT',
  'utm_campaign TEXT',
  'utm_content TEXT',
  'utm_term TEXT',
  'conversion_amount REAL DEFAULT 0',
  'conversion_currency TEXT DEFAULT "BRL"',
  'platform TEXT'
];
for (const colDef of analyticsCols) {
  try { db.exec(`ALTER TABLE analytics_events ADD COLUMN ${colDef}`); } catch (e) {}
}

const analyticsEnrichedCols = [
  'ip_address TEXT',
  'city TEXT',
  'region TEXT',
  'latitude REAL',
  'longitude REAL',
  'user_agent TEXT',
  'screen_width INTEGER',
  'screen_height INTEGER',
  'language TEXT',
  'timezone TEXT',
  'fbclid TEXT',
  'ttclid TEXT',
  'meta_em TEXT',
  'meta_ph TEXT',
  'meta_fn TEXT',
  'meta_ln TEXT',
  'meta_external_id TEXT'
];
for (const colDef of analyticsEnrichedCols) {
  try { db.exec(`ALTER TABLE analytics_events ADD COLUMN ${colDef}`); } catch (e) {}
}

try { db.exec("ALTER TABLE users ADD COLUMN onboarding_completed INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN file_size INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN folder_id TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN deleted_at DATETIME DEFAULT NULL"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN hls_ready INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN hls_manifest TEXT DEFAULT NULL"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN smartautoplay_url TEXT DEFAULT NULL"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN blocked_at DATETIME DEFAULT NULL"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN blocked_reason TEXT DEFAULT NULL"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN status TEXT DEFAULT 'ready'"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN optimization_progress INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN token TEXT"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder_id)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_videos_deleted ON videos(deleted_at)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_quota_logs_key_time ON api_quota_logs(api_key_id, timestamp)"); } catch (e) {}

try {
  db.prepare("UPDATE users SET onboarding_completed = 1 WHERE role = 'owner' OR onboarding_completed IS NULL").run();
} catch (e) {}

try {
  const localVids = db.prepare("SELECT id, file_path, file_size, duration FROM videos WHERE source_type = 'local'").all();
  for (const v of localVids) {
    if (v.file_path && fs.existsSync(v.file_path)) {
      try {
        const realSize = fs.statSync(v.file_path).size;
        if (!v.file_size || v.file_size !== realSize) {
          db.prepare("UPDATE videos SET file_size = ? WHERE id = ?").run(realSize, v.id);
        }
        if (!v.duration || v.duration === '10:00' || v.duration === '05:00') {
          const realDur = getVideoDurationFormatted(v.file_path);
          if (realDur) {
            db.prepare("UPDATE videos SET duration = ? WHERE id = ?").run(realDur, v.id);
          }
        }
      } catch (err) {}
    }
  }
} catch (e) {}

try {
  db.prepare(`
    UPDATE videos
    SET plays = (
      SELECT COUNT(*)
      FROM analytics_events
      WHERE analytics_events.video_id = videos.id AND analytics_events.event_type = 'play'
    )
  `).run();
} catch (e) {}

try {
  db.prepare("UPDATE analytics_events SET country = 'Moçambique', city = 'Maputo' WHERE LOWER(city) LIKE '%luanda%' OR country = 'Angola'").run();
  db.prepare("UPDATE analytics_events SET country = 'Moçambique', city = 'Maputo' WHERE LOWER(city) LIKE '%johannesburg%' AND (timezone = 'Africa/Maputo' OR country = 'Moçambique')").run();
  db.prepare("UPDATE analytics_events SET conversion_currency = 'MT' WHERE conversion_currency = 'BRL'").run();
} catch (e) {}

try {
  const vRows = db.prepare("SELECT id, settings_json FROM videos").all();
  for (const row of vRows) {
    if (!row.settings_json) continue;
    try {
      const parsed = JSON.parse(row.settings_json || '{}');
      let changed = false;
      if (!parsed.ctaUrl || parsed.ctaUrl === 'https://seusite.com/checkout' || !parsed.ctaUrl.trim()) {
        if (parsed.ctaEnabled || parsed.ctaUrl || parsed.ctaText || parsed.ctaSubtext) {
          parsed.ctaEnabled = false;
          parsed.ctaUrl = '';
          parsed.ctaText = '';
          parsed.ctaSubtext = '';
          changed = true;
        }
      }
      if (parsed.pixels === true) {
        parsed.pixels = false;
        changed = true;
      }
      if (changed) {
        db.prepare("UPDATE videos SET settings_json = ? WHERE id = ?").run(JSON.stringify(parsed), row.id);
      }
    } catch (err) {}
  }
} catch (e) {}

try {
  db.exec("DELETE FROM analytics_events WHERE visitor_id LIKE 'test_vis%' OR session_id LIKE 'test_sess%'");
} catch (e) {}

const getSetting = (key, defaultVal) => {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
};

const setSetting = (key, value) => {
  db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, String(value), String(value));
};

if (!getSetting('require_approval', null)) {
  setSetting('require_approval', '1');
}

const rawAllowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : [];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || NODE_ENV !== 'production' || rawAllowedOrigins.length === 0 || rawAllowedOrigins.includes('*')) {
      return callback(null, true);
    }
    const cleanOrigin = origin.toLowerCase().replace(/\/$/, '');
    const internalOrigins = [
      `https://${PLAYER_DOMAIN}`,
      `https://${DASH_DOMAIN}`,
      `https://${BASE_DOMAIN}`,
      `http://${PLAYER_DOMAIN}`,
      `http://${DASH_DOMAIN}`,
      `http://${BASE_DOMAIN}`
    ];
    if (internalOrigins.includes(cleanOrigin)) {
      return callback(null, true);
    }
    const isAllowed = rawAllowedOrigins.some(allowed => {
      if (allowed === '*' || cleanOrigin === allowed) return true;
      if (allowed.startsWith('*.') && cleanOrigin.endsWith(allowed.slice(1))) return true;
      return false;
    });
    return callback(null, isAllowed);
  },
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

app.get(['/favicon.ico', '/favicon.svg'], (req, res) => {
  res.type('image/svg+xml');
  res.sendFile(path.join(PUBLIC_DIR, 'favicon.svg'));
});

app.use((req, res, next) => {
  if (req.path === '/analytics-api' || req.path.startsWith('/analytics-api/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.sendFile(path.join(PUBLIC_DIR, 'analytics-api.html'));
  }

  const host = (req.headers.host || '').toLowerCase();

  if (host === PLAYER_DOMAIN || host.startsWith('player.')) {
    if (req.path.startsWith('/videos/') || req.path.startsWith('/api/')) {
      return next();
    }
    if (
      req.path === '/player' ||
      req.path === '/player.html' ||
      req.path === '/' ||
      req.path === '' ||
      req.path.startsWith('/embed/') ||
      req.path.startsWith('/v/') ||
      /^\/vsl_[a-zA-Z0-9_-]+$/.test(req.path)
    ) {
      return res.sendFile(path.join(PUBLIC_DIR, 'player.html'));
    }
  }

  if (host === BASE_DOMAIN || host === 'www.' + BASE_DOMAIN) {
    if (req.path === '/login') {
      return res.redirect(301, `https://${DASH_DOMAIN}/login`);
    }
    if (req.path === '/cadastro') {
      return res.redirect(301, `https://${DASH_DOMAIN}/cadastro`);
    }
    if (req.path === '/verificar-cadastro') {
      return res.redirect(301, `https://${DASH_DOMAIN}/verificar-cadastro`);
    }
    if (req.path === '/' || req.path === '/index.html' || req.path === '') {
      return res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
    }
    if (req.path === '/privacidade' || req.path === '/termos') {
      const isPrivacy = req.path === '/privacidade';
      const title = isPrivacy ? 'Política de Privacidade' : 'Termos de Serviço';
      const content = isPrivacy
        ? `<p>A <strong>CloudVTurb</strong> respeita sua privacidade. Coletamos apenas dados estritamente necessários para o funcionamento da plataforma:</p>
           <ul>
             <li><strong>Dados de conta:</strong> nome, e-mail e senha (criptografada) fornecidos no cadastro.</li>
             <li><strong>Vídeos hospedados:</strong> armazenados em servidores seguros e acessíveis apenas pelo proprietário da conta.</li>
             <li><strong>Métricas anônimas:</strong> visualizações, cliques em CTA e tempo de reprodução — sem identificar visitantes individualmente.</li>
             <li><strong>Google Drive:</strong> quando você importa um vídeo via Google Drive, acessamos apenas o arquivo selecionado. Não armazenamos suas credenciais do Google.</li>
           </ul>
           <p>Não vendemos, compartilhamos ou transferimos seus dados a terceiros. Você pode solicitar a exclusão completa da sua conta e dados a qualquer momento pelo e-mail de suporte.</p>`
        : `<p>Ao utilizar a plataforma <strong>CloudVTurb</strong>, você concorda com os seguintes termos:</p>
           <ul>
             <li>Você é responsável pelo conteúdo dos vídeos enviados à plataforma.</li>
             <li>A plataforma oferece hospedagem e entrega de vídeos no formato SaaS, sem garantia de disponibilidade ininterrupta.</li>
             <li>Reservamo-nos o direito de suspender contas que violem leis aplicáveis ou estes termos.</li>
             <li>Seus dados e vídeos são de sua propriedade. Não reivindicamos direitos sobre o conteúdo enviado.</li>
             <li>O serviço pode ser modificado ou descontinuado a qualquer momento, com aviso prévio aos usuários.</li>
           </ul>
           <p>Para dúvidas, entre em contato pelo e-mail de suporte disponível na plataforma.</p>`;
      return res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — CloudVTurb</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,system-ui,sans-serif;background:#09090b;color:#e4e4e7;padding:40px 20px;line-height:1.7}main{max-width:700px;margin:0 auto}h1{font-size:28px;font-weight:800;margin-bottom:24px;color:#fff}p{margin-bottom:16px;font-size:15px}ul{margin:12px 0 20px 24px}li{margin-bottom:8px;font-size:14.5px}a{color:#3b82f6}</style></head><body><main><h1>${title}</h1>${content}<p style="margin-top:32px;font-size:13px;color:#71717a;">Última atualização: setembro de 2026</p></main></body></html>`);
    }
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/videos/')) {
      return res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
    }
  }

  const dashRoutes = ['/', '/login', '/cadastro', '/verificar-cadastro', '/recuperar-senha', '/videos', '/metricas', '/usuarios', '/servidor', '/analytics', '/configuracoes', '/settings'];
  const isPlayerUiRoute = req.path.startsWith('/players/') && req.path !== '/players/list';
  if (dashRoutes.includes(req.path) || isPlayerUiRoute || req.path.startsWith('/settings/') || req.path.startsWith('/configuracoes/') || req.path.startsWith('/folders/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }

  if (req.path === '/player' || req.path.startsWith('/embed/')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'player.html'));
  }

  if (req.path === '/player.js' || req.path === '/sdk.js' || req.path.endsWith('/sdk.js')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(path.join(PUBLIC_DIR, 'player.js'));
  }

  next();
});

const vturbAnalyticsRouter = require('./vturb-analytics-api')(db);
app.use('/', vturbAnalyticsRouter);
app.use('/api/v1', vturbAnalyticsRouter);

app.use('/avatars', express.static(AVATARS_DIR));
app.use('/api/avatars', express.static(AVATARS_DIR));
app.use('/avatars', express.static(path.join(PUBLIC_DIR, 'avatars')));
app.get(['/avatars/:filename', '/api/avatars/:filename'], (req, res) => {
  const safeName = path.basename(req.params.filename);
  const p1 = path.join(AVATARS_DIR, safeName);
  if (fs.existsSync(p1)) return res.sendFile(p1);
  const p2 = path.join(PUBLIC_DIR, 'avatars', safeName);
  if (fs.existsSync(p2)) return res.sendFile(p2);
  res.status(404).send('Avatar não encontrado');
});
app.use(express.static(PUBLIC_DIR));

function getUsedStorageBytes() {
  try {
    let total = 0;
    const files = fs.readdirSync(VIDEOS_DIR);
    for (const f of files) {
      const fullPath = path.join(VIDEOS_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          total += stat.size;
        } else if (stat.isDirectory()) {
          const subFiles = fs.readdirSync(fullPath);
          for (const sf of subFiles) {
            try {
              const subStat = fs.statSync(path.join(fullPath, sf));
              if (subStat.isFile()) total += subStat.size;
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    return total;
  } catch (e) {
    return 0;
  }
}

function getUserStorageBytes(userId) {
  try {
    const row = db.prepare("SELECT COALESCE(SUM(file_size), 0) as total FROM videos WHERE user_id = ? AND source_type = 'local'").get(userId);
    return row ? row.total : 0;
  } catch (e) {
    return 0;
  }
}

function formatStorage(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const kb = bytes / 1024;
  const mb = bytes / (1024 * 1024);
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(2).replace('.', ',')} GB`;
  }
  if (mb >= 1) {
    return `${mb.toFixed(1).replace('.', ',')} MB`;
  }
  if (kb >= 1) {
    return `${kb.toFixed(0)} KB`;
  }
  return `${bytes} B`;
}

function getVideoDurationFormatted(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const probe = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { timeout: 10000 });
    const sec = parseFloat(probe.toString().trim());
    if (!isNaN(sec) && sec > 0) {
      const totalSec = Math.round(sec);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      if (h > 0) {
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
      }
      return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
  } catch (e) {}
  return null;
}

function processVideoHLS(vidId) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!v) return;

  let inputPath = v.file_path;
  if (!inputPath || !fs.existsSync(inputPath)) {
    if (v.video_url) {
      const candidate = path.join(VIDEOS_DIR, path.basename(v.video_url));
      if (fs.existsSync(candidate)) {
        inputPath = candidate;
        try { db.prepare('UPDATE videos SET file_path = ? WHERE id = ?').run(inputPath, vidId); } catch (e) {}
      }
    }
  }
  if (!inputPath || !fs.existsSync(inputPath)) {
    try { db.prepare("UPDATE videos SET status = 'ready' WHERE id = ?").run(vidId); } catch (e) {}
    return;
  }

  try { db.prepare("UPDATE videos SET status = 'optimizing', optimization_progress = 20 WHERE id = ?").run(vidId); } catch (e) {}

  const realDuration = getVideoDurationFormatted(inputPath);
  if (realDuration && (v.duration === '10:00' || v.duration === '05:00' || !v.duration)) {
    try { db.prepare('UPDATE videos SET duration = ? WHERE id = ?').run(realDuration, vidId); } catch (e) {}
  }

  dispatchWebhookEvent(v.user_id, 'video.processing', {
    video_id: vidId,
    name: v.title || '',
    progress: 20
  });

  const videoDir = path.join(VIDEOS_DIR, vidId);
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

  const smartautoplayPath = path.join(videoDir, 'smartautoplay-0s.mp4');
  const masterPlaylistPath = path.join(videoDir, 'main.m3u8');

  let hasAudio = false;
  try {
    const probe = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath
    ]);
    hasAudio = probe.toString().trim() === 'audio';
  } catch (e) {}

  const posterPath = path.join(videoDir, 'poster.jpg');
  if (!fs.existsSync(posterPath)) {
    try {
      const pProc = spawn('ffmpeg', ['-y', '-ss', '0.5', '-i', inputPath, '-vframes', '1', '-q:v', '2', posterPath]);
      pProc.on('error', () => {});
      pProc.on('close', (pCode) => {
        if (pCode === 0 && fs.existsSync(posterPath)) {
          const posterUrl = `/videos/${vidId}/poster.jpg`;
          try { db.prepare("UPDATE videos SET thumbnail = ?, optimization_progress = 45 WHERE id = ?").run(posterUrl, vidId); } catch (e) {}
        }
      });
    } catch (e) {}
  }

  const apArgs = [
    '-y',
    '-ss', '0',
    '-i', inputPath,
    '-t', '10',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '28',
    '-movflags', '+faststart',
    smartautoplayPath
  ];

  try {
    const apProc = spawn('ffmpeg', apArgs);
    apProc.on('error', () => {
      try { db.prepare("UPDATE videos SET status = 'ready', optimization_progress = 100 WHERE id = ?").run(vidId); } catch (e) {}
    });
    apProc.on('close', (apCode) => {
      if (apCode === 0 && fs.existsSync(smartautoplayPath)) {
        const smartUrl = `/videos/${vidId}/smartautoplay-0s.mp4`;
        try { db.prepare("UPDATE videos SET smartautoplay_url = ?, optimization_progress = 70 WHERE id = ?").run(smartUrl, vidId); } catch (e) {}
      }

      const filterComplex = '[0:v]split=3[v1][v2][v3]; [v1]scale=w=\'min(1280,iw)\':h=-2[v1out]; [v2]scale=w=\'min(854,iw)\':h=-2[v2out]; [v3]scale=w=\'min(640,iw)\':h=-2[v3out]';
      const hlsArgs = [
        '-y',
        '-i', inputPath,
        '-filter_complex', filterComplex,
        '-map', '[v1out]', '-c:v:0', 'libx264', '-preset', 'ultrafast', '-crf', '22',
        '-map', '[v2out]', '-c:v:1', 'libx264', '-preset', 'ultrafast', '-crf', '24',
        '-map', '[v3out]', '-c:v:2', 'libx264', '-preset', 'ultrafast', '-crf', '26'
      ];

      if (hasAudio) {
        hlsArgs.push(
          '-map', '0:a', '-c:a:0', 'aac', '-b:a:0', '128k',
          '-map', '0:a', '-c:a:1', 'aac', '-b:a:1', '96k',
          '-map', '0:a', '-c:a:2', 'aac', '-b:a:2', '64k',
          '-var_stream_map', 'v:0,a:0 v:1,a:1 v:2,a:2'
        );
      } else {
        hlsArgs.push(
          '-var_stream_map', 'v:0 v:1 v:2'
        );
      }

      hlsArgs.push(
        '-f', 'hls',
        '-hls_time', '3',
        '-hls_playlist_type', 'vod',
        '-hls_flags', 'independent_segments',
        '-master_pl_name', 'main.m3u8',
        '-hls_segment_filename', path.join(videoDir, 'segment_%v_%03d.ts'),
        path.join(videoDir, 'video_%v.m3u8')
      );

      try {
        const hlsProc = spawn('ffmpeg', hlsArgs);
        hlsProc.on('error', () => {
          try { db.prepare("UPDATE videos SET status = 'ready', optimization_progress = 100 WHERE id = ?").run(vidId); } catch (e) {}
          dispatchWebhookEvent(v.user_id, 'video.failed', {
            video_id: vidId,
            name: v.title || '',
            error: 'Erro ao iniciar transcodificação'
          });
        });
        hlsProc.on('close', (hlsCode) => {
          if (hlsCode === 0 && fs.existsSync(masterPlaylistPath)) {
            const manifestUrl = `/videos/${vidId}/main.m3u8`;
            try {
              db.prepare("UPDATE videos SET status = 'ready', optimization_progress = 100, hls_ready = 1, hls_manifest = ? WHERE id = ?").run(manifestUrl, vidId);
            } catch (e) {}
            dispatchWebhookEvent(v.user_id, 'video.ready', {
              video_id: vidId,
              name: v.title || '',
              hls_manifest: manifestUrl
            });
          } else {
            try { db.prepare("UPDATE videos SET status = 'ready', optimization_progress = 100 WHERE id = ?").run(vidId); } catch (e) {}
            dispatchWebhookEvent(v.user_id, 'video.failed', {
              video_id: vidId,
              name: v.title || '',
              error: 'Erro no processamento HLS'
            });
          }
        });
      } catch (hlsErr) {
        try { db.prepare("UPDATE videos SET status = 'ready', optimization_progress = 100 WHERE id = ?").run(vidId); } catch (e) {}
      }
    });
  } catch (err) {
    try { db.prepare("UPDATE videos SET status = 'ready', optimization_progress = 100 WHERE id = ?").run(vidId); } catch (e) {}
  }
}

function autoCheckPendingHls() {
  try {
    const allVids = db.prepare("SELECT id, file_path, video_url, hls_ready, hls_manifest, status FROM videos WHERE deleted_at IS NULL").all();
    for (const v of allVids) {
      const videoDir = path.join(VIDEOS_DIR, v.id);
      const masterPlaylist = path.join(videoDir, 'main.m3u8');
      if (fs.existsSync(masterPlaylist)) {
        if (!v.hls_ready || v.status === 'optimizing') {
          const manifestUrl = `/videos/${v.id}/main.m3u8`;
          db.prepare("UPDATE videos SET status = 'ready', hls_ready = 1, hls_manifest = ? WHERE id = ?").run(manifestUrl, v.id);
        }
      } else if (v.status === 'optimizing') {
        processVideoHLS(v.id);
      }

      const posterPath = path.join(videoDir, 'poster.jpg');
      if (!fs.existsSync(posterPath)) {
        let inputPath = v.file_path;
        if (!inputPath || !fs.existsSync(inputPath)) {
          if (v.video_url && v.video_url.startsWith('/videos/')) {
            const candidate = path.join(VIDEOS_DIR, path.basename(v.video_url));
            if (fs.existsSync(candidate)) inputPath = candidate;
          }
          if (!inputPath || !fs.existsSync(inputPath)) {
            try {
              if (fs.existsSync(videoDir)) {
                const files = fs.readdirSync(videoDir);
                const mp4 = files.find(f => f.endsWith('.mp4'));
                if (mp4) inputPath = path.join(videoDir, mp4);
              }
            } catch (e) {}
          }
        }
        if (inputPath && fs.existsSync(inputPath)) {
          try {
            const pProc2 = spawn('ffmpeg', ['-y', '-ss', '0.5', '-i', inputPath, '-vframes', '1', '-q:v', '2', posterPath]);
            pProc2.on('error', () => {});
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
}
setTimeout(autoCheckPendingHls, 3000);

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Não autorizado. Faça login.' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.isTemp2FA || decoded.isTempSetup2FA) {
      return res.status(401).json({ error: 'Autenticação de dois fatores pendente.' });
    }
    const user = db.prepare('SELECT id, name, email, role, status, full_name, country, phone, address_street, postal_code, state_province, onboarding_completed, avatar_url, owner_id, token_version, two_factor_enabled, require_member_2fa, google_connected, google_email FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado.' });
    if (user.status !== 'approved') return res.status(403).json({ error: 'Acesso bloqueado ou pendente de aprovação.' });
    if (decoded.token_version !== undefined && user.token_version && decoded.token_version !== user.token_version) {
      return res.status(401).json({ error: 'Sessão expirada ou encerrada em outro dispositivo.' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão expirada ou inválida.' });
  }
}

function ownerMiddleware(req, res, next) {
  if (req.user && (req.user.role === 'owner' || req.user.role === 'admin')) {
    next();
  } else {
    res.status(403).json({ error: 'Acesso restrito ao Administrador.' });
  }
}

function getSystemFromEmail() {
  const custom = (process.env.RESEND_FROM_EMAIL || '').trim();
  if (custom && !custom.includes('onboarding@resend.dev')) {
    return custom;
  }
  const domain = BASE_DOMAIN || 'localhost';
  return `${APP_NAME} <nao-responda@${domain}>`;
}

async function sendUserActionEmail({ to, name, action, reason, adminName }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return;

  const fromEmail = getSystemFromEmail();

  const labels = {
    block: { subject: 'Sua conta foi bloqueada', title: 'Conta Bloqueada', color: '#ef4444', icon: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01', desc: 'O acesso à sua conta na plataforma CloudVTurb foi suspenso pelo administrador.' },
    delete: { subject: 'Sua conta foi removida', title: 'Conta Removida', color: '#ef4444', icon: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', desc: 'Sua conta na plataforma CloudVTurb foi removida pelo administrador.' },
    make_owner: { subject: 'Voce foi promovido a Administrador', title: 'Promovido a Administrador', color: '#2563eb', icon: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z', desc: 'Parabens! Voce foi promovido a Administrador (Owner) na plataforma CloudVTurb.' }
  };

  const info = labels[action];
  if (!info) return;

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${info.title}</title></head>
<body style="margin:0;padding:24px;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e4e4e7;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
    <div style="font-size:22px;font-weight:800;color:#2563eb;margin-bottom:20px;letter-spacing:-0.5px;">CloudVTurb</div>
    <h2 style="font-size:18px;font-weight:700;color:#09090b;margin:0 0 12px 0;">${info.title}</h2>
    <p style="font-size:14px;line-height:1.6;color:#52525b;margin:0 0 16px 0;">Ola${name ? ` <strong>${escapeHtml(name)}</strong>` : ''},</p>
    <p style="font-size:14px;line-height:1.6;color:#52525b;margin:0 0 24px 0;">${info.desc}</p>
    ${reason ? `<div style="background:#f8fafc;border-left:3px solid ${info.color};border-radius:4px;padding:14px 16px;margin-bottom:24px;"><p style="font-size:13px;font-weight:600;color:#09090b;margin:0 0 6px 0;">Motivo informado pelo administrador:</p><p style="font-size:13px;color:#52525b;margin:0;">${escapeHtml(reason)}</p></div>` : ''}
    <p style="font-size:13px;color:#71717a;margin:0 0 24px 0;">Esta acao foi executada por <strong>${escapeHtml(adminName || 'Administrador')}</strong>. Para duvidas, entre em contato com o suporte da plataforma.</p>
    <div style="font-size:12px;color:#a1a1aa;border-top:1px solid #f4f4f5;padding-top:16px;">CloudVTurb - Plataforma de VSLs e Hospedagem de Alta Retencao</div>
  </div>
</body></html>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromEmail, to: [to], subject: info.subject, html })
    });
  } catch (e) {
    console.error('[CloudVTurb UserAction Email] Erro ao enviar:', e.message);
  }
}

const ALLOWED_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/avi',
  'video/x-msvideo',
  'video/x-m4v'
];
const ALLOWED_EXTS = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'];

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, VIDEOS_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    const uniqueName = 'vsl_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const isMimeVideo = file.mimetype && (file.mimetype.startsWith('video/') || ALLOWED_MIME_TYPES.includes(file.mimetype));
    const isExtVideo = ALLOWED_EXTS.includes(ext);
    if (!isExtVideo && !isMimeVideo) {
      return cb(new Error('Formato de arquivo inválido. Apenas vídeos (.mp4, .mov, .webm, .mkv, .avi, .m4v) são aceitos.'));
    }
    cb(null, true);
  }
});

function checkStorageQuotaPre(req, res, next) {
  const incomingLength = parseInt(req.headers['content-length'] || '0', 10);
  const isOwner = req.user && req.user.role === 'owner';
  if (!isOwner) {
    const userUsed = getUserStorageBytes(req.user ? req.user.id : 0);
    if (userUsed + incomingLength > MEMBER_STORAGE_LIMIT_BYTES) {
      return res.status(400).json({ error: 'Cota individual de 3 GB atingida. Remova vídeos para liberar espaço.' });
    }
  }
  const currentUsed = getUsedStorageBytes();
  if (currentUsed + incomingLength > SERVER_STORAGE_LIMIT_BYTES) {
    return res.status(400).json({ error: 'Capacidade do servidor temporariamente esgotada.' });
  }
  next();
}

app.get('/api/config', (req, res) => {
  const host = req.get('host') || '';
  const isProd = Boolean(BASE_DOMAIN && host.includes(BASE_DOMAIN));
  const playerDomain = (isProd && PLAYER_DOMAIN) ? `https://${PLAYER_DOMAIN}` : `${req.protocol}://${host}`;
  const dashDomain = (isProd && DASH_DOMAIN) ? `https://${DASH_DOMAIN}` : `${req.protocol}://${host}`;
  res.json({
    appName: APP_NAME,
    baseDomain: BASE_DOMAIN,
    playerDomain: playerDomain,
    dashDomain: dashDomain
  });
});

function generate8DigitCode() {
  return crypto.randomInt(10000000, 100000000).toString();
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function verifyTOTP(token, secretBase32) {
  if (!token || !secretBase32) return false;
  const cleanToken = String(token).trim();
  const epoch = Math.floor(Date.now() / 1000);
  const secretBytes = base32Decode(secretBase32);
  for (let offset = -1; offset <= 1; offset++) {
    const counter = Math.floor(epoch / 30) + offset;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', secretBytes).update(buf).digest();
    const o = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac.readUInt32BE(o) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
    if (code === cleanToken) return true;
  }
  return false;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function sendVerificationEmail({ to, code, type, name }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.log(`[CloudVTurb Auth] Codigo de verificacao para ${to} (${type}): ${code}`);
    if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_RESEND === 'true') {
      throw new Error('Chave RESEND_API_KEY não configurada no servidor (.env). Configure a chave da Resend para o envio de e-mails.');
    }
    return;
  }

  const fromEmail = getSystemFromEmail();
  const isRegister = type === 'register';
  const isChangePassword = type === 'change_password';
  const subject = isRegister
    ? `${code} é seu código de verificação - CloudVTurb`
    : (isChangePassword
      ? `${code} é seu código para alterar sua senha - CloudVTurb`
      : `${code} é seu código de recuperação de senha - CloudVTurb`);

  const title = isRegister
    ? 'Confirme seu Cadastro'
    : (isChangePassword ? 'Alteração de Senha' : 'Recuperação de Senha');
  const description = isRegister
    ? 'Use o código de 8 dígitos abaixo para confirmar seu e-mail e concluir o cadastro no CloudVTurb:'
    : (isChangePassword
      ? 'Recebemos uma solicitação para alterar a senha da sua conta CloudVTurb. Use o código de 8 dígitos abaixo para validar a operação:'
      : 'Recebemos uma solicitação de redefinição de senha para sua conta. Use o código de 8 dígitos abaixo:');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:24px;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e4e4e7;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
    <div style="font-size:22px;font-weight:800;color:#2563eb;margin-bottom:20px;letter-spacing:-0.5px;">CloudVTurb</div>
    <h2 style="font-size:18px;font-weight:700;color:#09090b;margin:0 0 12px 0;">${title}</h2>
    <p style="font-size:14px;line-height:1.6;color:#52525b;margin:0 0 16px 0;">Olá${name ? ` <strong>${escapeHtml(name)}</strong>` : ''},</p>
    <p style="font-size:14px;line-height:1.6;color:#52525b;margin:0 0 24px 0;">${description}</p>
    <div style="background:#f8fafc;border:2px dashed #2563eb;border-radius:8px;padding:18px;text-align:center;font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:800;letter-spacing:6px;color:#1d4ed8;margin-bottom:24px;">${code}</div>
    <p style="font-size:13px;line-height:1.5;color:#71717a;margin:0 0 24px 0;">Este código é válido por <strong>15 minutos</strong>. Se você não solicitou este código, por favor ignore este e-mail com segurança.</p>
    <div style="font-size:12px;color:#a1a1aa;border-top:1px solid #f4f4f5;padding-top:16px;">CloudVTurb - Plataforma de VSLs e Hospedagem de Alta Retenção</div>
  </div>
</body>
</html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [to],
      subject: subject,
      html: html
    })
  });

  const resJson = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = resJson.message || resJson.error || response.statusText || 'Erro desconhecido';
    throw new Error(`Falha no envio via Resend: ${detail}`);
  }

  return resJson;
}

async function sendInviteEmail({ to, name, inviterName, inviteLink, role }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.log(`[CloudVTurb Invite] Link de convite para ${to}: ${inviteLink}`);
    if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_RESEND === 'true') {
      throw new Error('Chave RESEND_API_KEY não configurada no servidor (.env). Configure a chave da Resend para o envio de e-mails.');
    }
    return;
  }

  const fromEmail = getSystemFromEmail();
  const roleLabel = role === 'admin' ? 'Administrador' : 'Usuário Comum';
  const subject = `${inviterName || 'Alguém'} convidou você para fazer parte da equipe no CloudVTurb`;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Convite para a equipe CloudVTurb</title>
</head>
<body style="margin:0;padding:24px;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px;border:1px solid #e4e4e7;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
    <div style="font-size:22px;font-weight:800;color:#2563eb;margin-bottom:24px;letter-spacing:-0.5px;">CloudVTurb</div>
    <h2 style="font-size:19px;font-weight:700;color:#09090b;margin:0 0 14px 0;">Você recebeu um convite para a equipe</h2>
    <p style="font-size:14px;line-height:1.6;color:#52525b;margin:0 0 16px 0;">Olá${name ? ` <strong>${escapeHtml(name)}</strong>` : ''},</p>
    <p style="font-size:14px;line-height:1.6;color:#52525b;margin:0 0 20px 0;">
      <strong>${escapeHtml(inviterName || 'Um administrador')}</strong> convidou você para fazer parte da equipe no <strong>CloudVTurb</strong> com o cargo de <strong>${roleLabel}</strong>.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${inviteLink}" style="display:inline-block;background-color:#2563eb;color:#ffffff;text-decoration:none;font-size:14.5px;font-weight:600;padding:12px 28px;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,0.1);">Aceitar Convite</a>
    </div>
    <p style="font-size:13px;line-height:1.5;color:#71717a;margin:0 0 12px 0;">
      Ou copie e cole o link direto no seu navegador:<br>
      <a href="${inviteLink}" style="color:#2563eb;word-break:break-all;font-size:12px;">${inviteLink}</a>
    </p>
    <p style="font-size:13px;line-height:1.5;color:#71717a;margin:16px 0 24px 0;">
      Este convite é de uso exclusivo e tem validade de <strong>24 horas</strong>. Se você não esperava este convite, pode ignorar este e-mail com segurança.
    </p>
    <div style="font-size:12px;color:#a1a1aa;border-top:1px solid #f4f4f5;padding-top:16px;">CloudVTurb — Plataforma de Hospedagem VSL de Alta Retenção</div>
  </div>
</body>
</html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [to],
      subject: subject,
      html: html
    })
  });

  const resJson = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = resJson.message || resJson.error || response.statusText || 'Erro desconhecido';
    throw new Error(`Falha no envio via Resend: ${detail}`);
  }
  return resJson;
}

async function sendVideoModerationEmail({ to, name, videoTitle, action, reason }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.log(`[CloudVTurb Moderation Email] Para: ${to} | Ação: ${action} | Vídeo: ${videoTitle} | Motivo: ${reason}`);
    if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_RESEND === 'true') {
      throw new Error('Chave RESEND_API_KEY não configurada no servidor (.env). Configure a chave da Resend para o envio de e-mails.');
    }
    return;
  }

  const fromEmail = getSystemFromEmail();

  let subject = '';
  let actionTitle = '';
  let badgeColor = '';
  let badgeBg = '';

  if (action === 'block') {
    subject = `Aviso Importante: Seu vídeo "${videoTitle}" foi bloqueado`;
    actionTitle = 'Vídeo Bloqueado pela Administração';
    badgeColor = '#dc2626';
    badgeBg = '#fee2e2';
  } else if (action === 'delete') {
    subject = `Aviso Importante: Seu vídeo "${videoTitle}" foi excluído do servidor`;
    actionTitle = 'Vídeo Removido do Servidor';
    badgeColor = '#b91c1c';
    badgeBg = '#fee2e2';
  } else if (action === 'unblock') {
    subject = `Aviso: Seu vídeo "${videoTitle}" foi reativado`;
    actionTitle = 'Vídeo Desbloqueado';
    badgeColor = '#16a34a';
    badgeBg = '#dcfce7';
  }

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(actionTitle)}</title>
</head>
<body style="margin:0;padding:24px;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px;border:1px solid #e4e4e7;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
    <div style="font-size:22px;font-weight:800;color:#2563eb;margin-bottom:24px;letter-spacing:-0.5px;">CloudVTurb</div>
    <div style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700;color:${badgeColor};background:${badgeBg};margin-bottom:16px;">
      ${escapeHtml(actionTitle)}
    </div>
    <h2 style="font-size:19px;font-weight:700;color:#09090b;margin:0 0 14px 0;">Notificação sobre seu vídeo</h2>
    <p style="font-size:14px;line-height:1.6;color:#52525b;margin:0 0 16px 0;">Olá${name ? ` <strong>${escapeHtml(name)}</strong>` : ''},</p>
    <p style="font-size:14px;line-height:1.6;color:#52525b;margin:0 0 20px 0;">
      A administração da plataforma aplicou uma ação sobre o seu vídeo <strong>"${escapeHtml(videoTitle)}"</strong>.
    </p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:20px 0;">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;margin-bottom:6px;">Motivo / Justificativa informada:</div>
      <div style="font-size:14px;color:#1e293b;line-height:1.6;white-space:pre-wrap;">${escapeHtml(reason || 'Sem justificativa informada.')}</div>
    </div>
    <p style="font-size:13px;line-height:1.5;color:#71717a;margin:20px 0 24px 0;">
      Caso tenha dúvidas sobre esta decisão, entre em contato diretamente com o administrador da sua organização.
    </p>
    <div style="font-size:12px;color:#a1a1aa;border-top:1px solid #f4f4f5;padding-top:16px;">CloudVTurb — Plataforma de Hospedagem VSL</div>
  </div>
</body>
</html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [to],
      subject: subject,
      html: html
    })
  });

  const resJson = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = resJson.message || resJson.error || response.statusText || 'Erro desconhecido';
    throw new Error(`Falha no envio via Resend: ${detail}`);
  }
  return resJson;
}

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos.' });

  const cleanName = String(name).trim();
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanPassword = String(password);

  if (cleanPassword.length < 6) {
    return res.status(400).json({ error: 'A senha deve conter no mínimo 6 caracteres.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) return res.status(400).json({ error: 'Este e-mail já está cadastrado.' });

  const recent = db.prepare(`
    SELECT created_at FROM verification_codes
    WHERE email = ? AND type = 'register'
    ORDER BY id DESC LIMIT 1
  `).get(cleanEmail);

  if (recent) {
    const elapsed = Date.now() - new Date(recent.created_at).getTime();
    if (elapsed < 45000) {
      const waitSec = Math.ceil((45000 - elapsed) / 1000);
      return res.status(429).json({ error: `Aguarde ${waitSec} segundos antes de solicitar um novo código.` });
    }
  }

  const passwordHash = bcrypt.hashSync(cleanPassword, 10);
  const code = generate8DigitCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const payload = JSON.stringify({ name: cleanName, passwordHash });

  try {
    await sendVerificationEmail({ to: cleanEmail, code, type: 'register', name: cleanName });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Erro ao enviar código de verificação por e-mail.' });
  }

  db.prepare(`DELETE FROM verification_codes WHERE email = ? AND type = 'register'`).run(cleanEmail);
  db.prepare(`
    INSERT INTO verification_codes (email, code, type, payload, attempts, expires_at)
    VALUES (?, ?, 'register', ?, 0, ?)
  `).run(cleanEmail, code, payload, expiresAt);

  res.json({
    success: true,
    requireVerification: true,
    email: cleanEmail,
    message: 'Código de 8 dígitos enviado para o seu e-mail.'
  });
});

app.post('/api/auth/verify-register', (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'Informe o e-mail e o código de 8 dígitos.' });

  const cleanEmail = String(email).trim().toLowerCase();
  const cleanCode = String(code).trim().replace(/\D/g, '');

  if (cleanCode.length !== 8) {
    return res.status(400).json({ error: 'O código deve conter exatamente 8 dígitos numéricos.' });
  }

  const record = db.prepare(`
    SELECT * FROM verification_codes
    WHERE email = ? AND type = 'register'
    ORDER BY id DESC LIMIT 1
  `).get(cleanEmail);

  if (!record || new Date(record.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Código de verificação expirado ou inválido. Solicite um novo código.' });
  }

  if (record.attempts >= 5) {
    db.prepare('DELETE FROM verification_codes WHERE id = ?').run(record.id);
    return res.status(400).json({ error: 'Limite de tentativas excedido. Solicite um novo código.' });
  }

  if (record.code !== cleanCode) {
    db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').run(record.id);
    return res.status(400).json({ error: 'Código incorreto. Verifique os 8 dígitos informados no seu e-mail.' });
  }

  let payload;
  try {
    payload = JSON.parse(record.payload);
  } catch (e) {
    return res.status(400).json({ error: 'Erro ao processar dados de cadastro. Tente cadastrar novamente.' });
  }

  db.prepare('DELETE FROM verification_codes WHERE id = ?').run(record.id);

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) {
    return res.status(400).json({ error: 'Este e-mail já foi registrado.' });
  }

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;

  const nowIso = new Date().toISOString();
  if (userCount === 0) {
    const info = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, status, created_at)
      VALUES (?, ?, ?, 'owner', 'approved', ?)
    `).run(payload.name, cleanEmail, payload.passwordHash, nowIso);

    const token = jwt.sign({ id: info.lastInsertRowid, email: cleanEmail, role: 'owner', token_version: 1 }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({
      success: true,
      message: 'Conta de Administrador criada e verificada com sucesso!',
      token,
      user: { id: info.lastInsertRowid, name: payload.name, email: cleanEmail, role: 'owner', status: 'approved' }
    });
  }

  const requireApproval = getSetting('require_approval', '1') === '1';
  const initialStatus = requireApproval ? 'pending' : 'approved';

  const info = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, status, created_at)
    VALUES (?, ?, ?, 'member', ?, ?)
  `).run(payload.name, cleanEmail, payload.passwordHash, initialStatus, nowIso);

  if (initialStatus === 'pending') {
    return res.json({
      success: true,
      pendingApproval: true,
      message: 'Cadastro confirmado! Aguarde a aprovação do Administrador para acessar a plataforma.'
    });
  } else {
    const token = jwt.sign({ id: info.lastInsertRowid, email: cleanEmail, role: 'member', token_version: 1 }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({
      success: true,
      pendingApproval: false,
      token,
      user: { id: info.lastInsertRowid, name: payload.name, email: cleanEmail, role: 'member', status: 'approved' }
    });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Informe o e-mail cadastrado.' });

  const cleanEmail = String(email).trim().toLowerCase();
  const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(cleanEmail);
  if (!user) {
    return res.status(404).json({ error: 'Nenhuma conta encontrada com este e-mail.' });
  }

  const recent = db.prepare(`
    SELECT created_at FROM verification_codes
    WHERE email = ? AND type = 'reset_password'
    ORDER BY id DESC LIMIT 1
  `).get(cleanEmail);

  if (recent) {
    const elapsed = Date.now() - new Date(recent.created_at).getTime();
    if (elapsed < 45000) {
      const waitSec = Math.ceil((45000 - elapsed) / 1000);
      return res.status(429).json({ error: `Aguarde ${waitSec} segundos antes de solicitar um novo código.` });
    }
  }

  const code = generate8DigitCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  try {
    await sendVerificationEmail({ to: cleanEmail, code, type: 'reset_password', name: user.name });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Erro ao enviar código de recuperação por e-mail.' });
  }

  db.prepare(`DELETE FROM verification_codes WHERE email = ? AND type = 'reset_password'`).run(cleanEmail);
  db.prepare(`
    INSERT INTO verification_codes (email, code, type, attempts, expires_at)
    VALUES (?, ?, 'reset_password', 0, ?)
  `).run(cleanEmail, code, expiresAt);

  res.json({
    success: true,
    message: 'Código de 8 dígitos enviado com sucesso para o seu e-mail.'
  });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'Informe e-mail, o código de 8 dígitos e a nova senha.' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const cleanCode = String(code).trim().replace(/\D/g, '');
  const cleanPassword = String(newPassword);

  if (cleanCode.length !== 8) {
    return res.status(400).json({ error: 'O código deve conter exatamente 8 dígitos numéricos.' });
  }
  if (cleanPassword.length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres.' });
  }

  const record = db.prepare(`
    SELECT * FROM verification_codes
    WHERE email = ? AND type = 'reset_password'
    ORDER BY id DESC LIMIT 1
  `).get(cleanEmail);

  if (!record || new Date(record.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Código de recuperação expirado ou inválido. Solicite novamente.' });
  }

  if (record.attempts >= 5) {
    db.prepare('DELETE FROM verification_codes WHERE id = ?').run(record.id);
    return res.status(400).json({ error: 'Limite de tentativas excedido. Solicite um novo código.' });
  }

  if (record.code !== cleanCode) {
    db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').run(record.id);
    return res.status(400).json({ error: 'Código incorreto. Verifique os 8 dígitos recebidos por e-mail.' });
  }

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }

  const passwordHash = bcrypt.hashSync(cleanPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(passwordHash, cleanEmail);
  db.prepare('DELETE FROM verification_codes WHERE id = ?').run(record.id);

  res.json({
    success: true,
    message: 'Senha alterada com sucesso! Você já pode entrar com sua nova senha.'
  });
});

app.post('/api/auth/resend-code', async (req, res) => {
  const { email, type } = req.body || {};
  if (!email || !type) return res.status(400).json({ error: 'Parâmetros insuficientes.' });

  const cleanEmail = String(email).trim().toLowerCase();
  if (type !== 'register' && type !== 'reset_password') {
    return res.status(400).json({ error: 'Tipo de verificação inválido.' });
  }

  const record = db.prepare(`
    SELECT * FROM verification_codes
    WHERE email = ? AND type = ?
    ORDER BY id DESC LIMIT 1
  `).get(cleanEmail, type);

  if (!record) {
    return res.status(400).json({
      error: type === 'register'
        ? 'Sessão de cadastro expirada. Preencha seus dados novamente.'
        : 'Nenhuma solicitação de recuperação encontrada. Solicite o código novamente.'
    });
  }

  const elapsed = Date.now() - new Date(record.created_at).getTime();
  if (elapsed < 45000) {
    const waitSec = Math.ceil((45000 - elapsed) / 1000);
    return res.status(429).json({ error: `Aguarde ${waitSec} segundos antes de solicitar um novo código.` });
  }

  let userName = '';
  if (type === 'register') {
    try {
      userName = JSON.parse(record.payload).name || '';
    } catch (e) {}
  } else {
    const u = db.prepare('SELECT name FROM users WHERE email = ?').get(cleanEmail);
    if (u) userName = u.name;
  }

  const newCode = generate8DigitCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  try {
    await sendVerificationEmail({ to: cleanEmail, code: newCode, type, name: userName });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Erro ao enviar código por e-mail.' });
  }

  db.prepare(`
    UPDATE verification_codes
    SET code = ?, attempts = 0, expires_at = ?, created_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newCode, expiresAt, record.id);

  res.json({
    success: true,
    message: 'Novo código de 8 dígitos enviado com sucesso!'
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Informe e-mail e senha.' });

  const cleanEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }

  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Sua conta está aguardando aprovação do Administrador.' });
  }
  if (user.status === 'blocked') {
    return res.status(403).json({ error: 'Sua conta foi desativada pelo Administrador.' });
  }

  if (user.two_factor_enabled) {
    const tempToken = jwt.sign({ id: user.id, isTemp2FA: true }, JWT_SECRET, { expiresIn: '10m' });
    return res.json({
      requires2FA: true,
      tempToken,
      message: 'Digite o código de 6 dígitos do seu aplicativo autenticador.'
    });
  }

  if (user.owner_id) {
    const owner = db.prepare('SELECT require_member_2fa FROM users WHERE id = ?').get(user.owner_id);
    if (owner && owner.require_member_2fa && !user.two_factor_enabled) {
      const tempToken = jwt.sign({ id: user.id, isTempSetup2FA: true }, JWT_SECRET, { expiresIn: '15m' });
      return res.json({
        requiresSetup2FA: true,
        tempToken,
        email: user.email,
        message: 'Sua organização exige que você ative a autenticação de dois fatores antes de acessar.'
      });
    }
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, token_version: user.token_version || 1 }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      full_name: user.full_name,
      country: user.country,
      phone: user.phone,
      address_street: user.address_street,
      postal_code: user.postal_code,
      state_province: user.state_province,
      onboarding_completed: Boolean(user.onboarding_completed)
    }
  });
});

app.post('/api/auth/verify-2fa', (req, res) => {
  const { tempToken, code } = req.body || {};
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Parâmetros insuficientes.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(tempToken, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Sessão temporária expirada. Faça login novamente.' });
  }

  if (!decoded.isTemp2FA) {
    return res.status(400).json({ error: 'Token inválido para verificação de 2FA.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
  if (!user || !user.two_factor_secret) {
    return res.status(400).json({ error: 'Configuração de 2FA não encontrada.' });
  }

  const isValid = verifyTOTP(code, user.two_factor_secret);
  if (!isValid) {
    return res.status(400).json({ error: 'Código de 6 dígitos incorreto ou expirado.' });
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, token_version: user.token_version || 1 }, JWT_SECRET, { expiresIn: '30d' });

  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      full_name: user.full_name,
      country: user.country,
      phone: user.phone,
      address_street: user.address_street,
      postal_code: user.postal_code,
      state_province: user.state_province,
      onboarding_completed: Boolean(user.onboarding_completed)
    }
  });
});

app.post('/api/auth/setup-member-2fa', async (req, res) => {
  const { tempToken } = req.body || {};
  if (!tempToken) return res.status(400).json({ error: 'Token temporário ausente.' });

  let decoded;
  try {
    decoded = jwt.verify(tempToken, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Sessão temporária expirada.' });
  }

  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(decoded.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const secretBytes = crypto.randomBytes(20);
  const secretBase32 = base32Encode(secretBytes);
  db.prepare('UPDATE users SET two_factor_temp_secret = ? WHERE id = ?').run(secretBase32, user.id);

  const issuer = 'CloudVTurb';
  const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user.email)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}`;
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 220, margin: 1 });

  res.json({
    success: true,
    secret: secretBase32,
    qrCode: qrCodeDataUrl
  });
});

app.post('/api/auth/confirm-member-2fa', (req, res) => {
  const { tempToken, code } = req.body || {};
  if (!tempToken || !code) return res.status(400).json({ error: 'Parâmetros insuficientes.' });

  let decoded;
  try {
    decoded = jwt.verify(tempToken, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Sessão temporária expirada.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
  if (!user || !user.two_factor_temp_secret) {
    return res.status(400).json({ error: 'Configuração de 2FA não iniciada.' });
  }

  const isValid = verifyTOTP(code, user.two_factor_temp_secret);
  if (!isValid) {
    return res.status(400).json({ error: 'Código de 6 dígitos incorreto ou expirado.' });
  }

  db.prepare(`
    UPDATE users
    SET two_factor_enabled = 1, two_factor_secret = two_factor_temp_secret, two_factor_temp_secret = NULL
    WHERE id = ?
  `).run(user.id);

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, token_version: user.token_version || 1 }, JWT_SECRET, { expiresIn: '30d' });

  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      full_name: user.full_name,
      country: user.country,
      phone: user.phone,
      address_street: user.address_street,
      postal_code: user.postal_code,
      state_province: user.state_province,
      onboarding_completed: Boolean(user.onboarding_completed)
    }
  });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/onboarding/status', authMiddleware, (req, res) => {
  res.json({
    onboardingCompleted: Boolean(req.user.onboarding_completed),
    user: req.user
  });
});

app.post('/api/onboarding/profile', authMiddleware, (req, res) => {
  const { fullName, country, phone, addressStreet, postalCode, stateProvince } = req.body || {};

  if (!fullName || !country || !phone || !addressStreet || !postalCode || !stateProvince) {
    return res.status(400).json({ error: 'Todos os campos de endereço e contato são obrigatórios.' });
  }

  db.prepare(`
    UPDATE users SET
      full_name = ?,
      country = ?,
      phone = ?,
      address_street = ?,
      postal_code = ?,
      state_province = ?,
      onboarding_completed = 1
    WHERE id = ?
  `).run(
    String(fullName).trim().slice(0, 150),
    String(country).trim().slice(0, 80),
    String(phone).trim().slice(0, 40),
    String(addressStreet).trim().slice(0, 200),
    String(postalCode).trim().slice(0, 30),
    String(stateProvince).trim().slice(0, 80),
    req.user.id
  );

  const updated = db.prepare('SELECT id, name, email, role, status, full_name, country, phone, address_street, postal_code, state_province, onboarding_completed FROM users WHERE id = ?').get(req.user.id);
  res.json({ success: true, user: updated });
});

app.post('/api/onboarding/complete', authMiddleware, (req, res) => {
  db.prepare('UPDATE users SET onboarding_completed = 1 WHERE id = ?').run(req.user.id);
  res.json({ success: true });
});

app.get('/api/admin/users', authMiddleware, ownerMiddleware, (req, res) => {
  try {
    const users = db.prepare('SELECT id, name, email, role, status, created_at FROM users ORDER BY created_at DESC').all();
    const usersWithStorage = users.map(u => {
      let usedBytes = 0;
      let videoCount = 0;
      try {
        usedBytes = getUserStorageBytes(u.id);
        const countRow = db.prepare('SELECT COUNT(*) as count FROM videos WHERE user_id = ?').get(u.id);
        videoCount = countRow ? countRow.count : 0;
      } catch (err) {}
      return {
        ...u,
        storageBytes: usedBytes,
        storageFormatted: formatStorage(usedBytes),
        videoCount
      };
    });
    res.json({ users: usersWithStorage });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar usuários: ' + err.message });
  }
});

app.post('/api/admin/users/:id/action', authMiddleware, ownerMiddleware, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const { action, reason } = req.body;

  if (targetId === req.user.id && (action === 'block' || action === 'delete')) {
    return res.status(400).json({ error: 'Voce nao pode alterar o status da sua propria conta.' });
  }

  if ((action === 'block' || action === 'delete' || action === 'make_owner') && (!reason || !String(reason).trim())) {
    return res.status(400).json({ error: 'Informe o motivo da acao.' });
  }

  const target = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(targetId);

  if (action === 'approve') {
    db.prepare("UPDATE users SET status = 'approved' WHERE id = ?").run(targetId);
  } else if (action === 'block') {
    db.prepare("UPDATE users SET status = 'blocked' WHERE id = ?").run(targetId);
  } else if (action === 'make_owner') {
    db.prepare("UPDATE users SET role = 'owner', status = 'approved' WHERE id = ?").run(targetId);
  } else if (action === 'delete') {
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  }

  if (target && (action === 'block' || action === 'delete' || action === 'make_owner')) {
    sendUserActionEmail({
      to: target.email,
      name: target.name,
      action,
      reason: String(reason).trim(),
      adminName: req.user.name
    }).catch(() => {});

    if (action === 'make_owner') {
      const notif = {
        id: Date.now(),
        type: 'promotion',
        title: 'Voce foi promovido a Administrador',
        message: String(reason).trim() || 'Parabens pela promocao!',
        created_at: new Date().toISOString(),
        read: 0
      };
      db.prepare(`INSERT INTO user_notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)`)
        .run(targetId, notif.type, notif.title, notif.message);
    }
  }

  res.json({ success: true });
});

app.get('/api/user/notifications/stream', (req, res) => {
  res.status(204).end();
});

app.get('/api/user/notifications', authMiddleware, (req, res) => {
  const notifs = db.prepare('SELECT * FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(req.user.id);
  const unreadCount = db.prepare('SELECT COUNT(*) as c FROM user_notifications WHERE user_id = ? AND read = 0').get(req.user.id);
  res.json({ notifications: notifs, unreadCount: unreadCount ? unreadCount.c : 0 });
});

app.post('/api/user/notifications/read-all', authMiddleware, (req, res) => {
  db.prepare('UPDATE user_notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

app.post('/api/user/password/verify-code', authMiddleware, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Informe o codigo de verificacao.' });

  const cleanCode = String(code).trim().replace(/\D/g, '');
  if (cleanCode.length !== 8) return res.status(400).json({ error: 'O codigo deve conter 8 digitos.' });

  const user = req.user;
  const record = db.prepare(`
    SELECT * FROM verification_codes
    WHERE email = ? AND type = 'change_password'
    ORDER BY id DESC LIMIT 1
  `).get(user.email);

  if (!record || new Date(record.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Codigo expirado ou invalido. Solicite um novo.' });
  }

  if (record.code !== cleanCode) {
    return res.status(400).json({ error: 'Codigo incorreto. Verifique os 8 digitos recebidos por e-mail.' });
  }

  res.json({ success: true });
});

app.get('/api/admin/settings', authMiddleware, (req, res) => {
  const isOwner = req.user.role === 'owner';
  const requireApproval = isOwner ? (getSetting('require_approval', '1') === '1') : false;

  if (isOwner) {
    const usedBytes = getUsedStorageBytes();
    const totalBytes = SERVER_STORAGE_LIMIT_BYTES;
    const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    return res.json({
      isOwner: true,
      requireApproval,
      appName: APP_NAME,
      baseDomain: BASE_DOMAIN,
      playerDomain: PLAYER_DOMAIN,
      dashDomain: DASH_DOMAIN,
      storage: {
        usedBytes,
        totalBytes,
        usedMB: (usedBytes / (1024 * 1024)).toFixed(1),
        usedGB: (usedBytes / (1024 * 1024 * 1024)).toFixed(2),
        formattedUsage: formatStorage(usedBytes),
        totalFormatted: '30 GB',
        totalGB: '30',
        usagePercent: percent < 0.1 && usedBytes > 0 ? '0.1' : percent.toFixed(1),
        isIndividual: false
      }
    });
  }

  const usedBytes = getUserStorageBytes(req.user.id);
  const totalBytes = MEMBER_STORAGE_LIMIT_BYTES;
  const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  res.json({
    isOwner: false,
    appName: APP_NAME,
    baseDomain: BASE_DOMAIN,
    playerDomain: PLAYER_DOMAIN,
    dashDomain: DASH_DOMAIN,
    storage: {
      usedBytes,
      totalBytes,
      usedMB: (usedBytes / (1024 * 1024)).toFixed(1),
      usedGB: (usedBytes / (1024 * 1024 * 1024)).toFixed(2),
      formattedUsage: formatStorage(usedBytes),
      totalFormatted: '3 GB',
      totalGB: '3',
      usagePercent: percent < 0.1 && usedBytes > 0 ? '0.1' : percent.toFixed(1),
      isIndividual: true
    }
  });
});

app.post('/api/admin/settings', authMiddleware, ownerMiddleware, (req, res) => {
  const { requireApproval } = req.body;
  if (requireApproval !== undefined) {
    setSetting('require_approval', requireApproval ? '1' : '0');
  }
  res.json({ success: true });
});

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
    cb(null, AVATARS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `avatar_${req.user.id}_${Date.now()}${ext}`);
  }
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isImg = (file.mimetype && file.mimetype.startsWith('image/')) ||
      /\.(jpe?g|png|webp|gif|bmp|svg|jfif|heic|avif)$/i.test(file.originalname);
    if (isImg) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos de imagem são permitidos (PNG, JPEG, WEBP, GIF, etc).'));
    }
  }
});

app.get('/api/user/profile', authMiddleware, (req, res) => {
  const user = db.prepare(`
    SELECT id, name, email, role, status, full_name, first_name, last_name, phone, avatar_url, created_at
    FROM users WHERE id = ?
  `).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.json({ user });
});

app.put('/api/user/profile', authMiddleware, (req, res) => {
  const { firstName, lastName, email, phone } = req.body || {};
  const cleanFirst = (firstName || '').trim().slice(0, 50);
  const cleanLast = (lastName || '').trim().slice(0, 50);
  const cleanPhone = (phone || '').trim().slice(0, 30);
  const cleanEmail = email ? email.trim().toLowerCase() : null;

  if (cleanEmail) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(cleanEmail, req.user.id);
    if (existing) {
      return res.status(400).json({ error: 'Este e-mail já está em uso por outra conta.' });
    }
  }

  const combinedName = [cleanFirst, cleanLast].filter(Boolean).join(' ') || req.user.name;

  db.prepare(`
    UPDATE users
    SET first_name = ?, last_name = ?, name = ?, phone = ?, email = COALESCE(?, email)
    WHERE id = ?
  `).run(cleanFirst, cleanLast, combinedName, cleanPhone, cleanEmail, req.user.id);

  const updated = db.prepare(`
    SELECT id, name, email, role, status, first_name, last_name, phone, avatar_url, created_at
    FROM users WHERE id = ?
  `).get(req.user.id);

  res.json({ success: true, user: updated });
});

app.post('/api/user/avatar', authMiddleware, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'A imagem é muito grande. O limite máximo é de 25 MB.'
        : (err.message || 'Falha no upload do avatar.');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });

    const avatarUrl = `/avatars/${req.file.filename}`;
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user.id);

    console.log(`[AVATAR] Upload realizado pelo usuário #${req.user.id} (${req.user.email || req.user.name}): ${req.file.filename} (${(req.file.size / (1024 * 1024)).toFixed(2)} MB)`);

    res.json({ success: true, avatarUrl });
  });
});

app.delete('/api/user/avatar', authMiddleware, (req, res) => {
  db.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').run(req.user.id);
  res.json({ success: true });
});

app.post('/api/user/password/request-code', authMiddleware, async (req, res) => {
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.email) {
    return res.status(400).json({ error: 'E-mail do usuário não localizado.' });
  }

  const existing = db.prepare(`
    SELECT * FROM verification_codes
    WHERE email = ? AND type = 'change_password' AND expires_at > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).get(user.email);

  if (existing) {
    const elapsed = Date.now() - new Date(existing.created_at).getTime();
    if (elapsed < 45000) {
      const waitSec = Math.ceil((45000 - elapsed) / 1000);
      return res.status(429).json({ error: `Aguarde ${waitSec} segundos antes de solicitar um novo código.` });
    }
  }

  const code = generate8DigitCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  try {
    await sendVerificationEmail({ to: user.email, code, type: 'change_password', name: user.name });
  } catch (err) {
    console.error('[CloudVTurb Password Code] Erro ao enviar e-mail:', err.message);
    return res.status(400).json({ error: err.message || 'Erro ao enviar e-mail de verificação.' });
  }

  db.prepare(`DELETE FROM verification_codes WHERE email = ? AND type = 'change_password'`).run(user.email);
  db.prepare(`
    INSERT INTO verification_codes (email, code, type, payload, expires_at)
    VALUES (?, ?, 'change_password', ?, ?)
  `).run(user.email, code, JSON.stringify({ userId: user.id }), expiresAt);

  res.json({ success: true, message: `Código de verificação enviado para ${user.email}.` });
});

app.post('/api/user/password', authMiddleware, (req, res) => {
  const { code, newPassword } = req.body || {};
  if (!code || String(code).trim().length !== 8) {
    return res.status(400).json({ error: 'Informe o código de verificação de 8 dígitos.' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres.' });
  }

  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.user.id);
  const cleanCode = String(code).trim();

  const record = db.prepare(`
    SELECT * FROM verification_codes
    WHERE email = ? AND type = 'change_password' AND expires_at > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).get(user.email);

  if (!record) {
    return res.status(400).json({ error: 'Código de verificação expirado ou inválido. Solicite um novo.' });
  }

  if (record.attempts >= 5) {
    db.prepare('DELETE FROM verification_codes WHERE id = ?').run(record.id);
    return res.status(429).json({ error: 'Limite de tentativas excedido. Solicite um novo código.' });
  }

  if (record.code !== cleanCode) {
    db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').run(record.id);
    return res.status(400).json({ error: 'Código de verificação incorreto.' });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  db.prepare('DELETE FROM verification_codes WHERE id = ?').run(record.id);

  res.json({ success: true, message: 'Senha alterada com sucesso!' });
});

app.post('/api/user/logout-all', authMiddleware, (req, res) => {
  const newVersion = (req.user.token_version || 1) + 1;
  db.prepare('UPDATE users SET token_version = ? WHERE id = ?').run(newVersion, req.user.id);

  const newToken = jwt.sign({
    id: req.user.id,
    email: req.user.email,
    role: req.user.role,
    token_version: newVersion
  }, JWT_SECRET, { expiresIn: '30d' });

  res.json({
    success: true,
    token: newToken,
    message: 'Todas as outras sessões foram encerradas com sucesso.'
  });
});

app.get('/api/user/google/status', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT google_connected, google_email FROM users WHERE id = ?').get(req.user.id);
  res.json({
    connected: Boolean(user && user.google_connected),
    email: (user && user.google_email) || null
  });
});

app.post('/api/user/google/connect', authMiddleware, async (req, res) => {
  const { accessToken } = req.body || {};
  let email = null;
  if (accessToken) {
    try {
      const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (userInfoRes.ok) {
        const data = await userInfoRes.json();
        email = data.email || null;
      }
    } catch (e) {}
  }
  db.prepare('UPDATE users SET google_connected = 1, google_email = ? WHERE id = ?').run(email, req.user.id);
  res.json({ success: true, connected: true, email });
});

app.post('/api/user/google/disconnect', authMiddleware, (req, res) => {
  db.prepare('UPDATE users SET google_connected = 0, google_email = NULL WHERE id = ?').run(req.user.id);
  res.json({ success: true, connected: false, message: 'Conta do Google Drive desconectada.' });
});

app.get('/api/user/2fa/status', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT two_factor_enabled FROM users WHERE id = ?').get(req.user.id);
  res.json({ enabled: Boolean(user && user.two_factor_enabled) });
});

app.post('/api/user/2fa/setup', authMiddleware, async (req, res) => {
  const secretBytes = crypto.randomBytes(20);
  const secretBase32 = base32Encode(secretBytes);
  db.prepare('UPDATE users SET two_factor_temp_secret = ? WHERE id = ?').run(secretBase32, req.user.id);

  const issuer = 'CloudVTurb';
  const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(req.user.email)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}`;
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 220, margin: 1 });

  res.json({
    success: true,
    secret: secretBase32,
    qrCode: qrCodeDataUrl
  });
});

app.post('/api/user/2fa/enable', authMiddleware, (req, res) => {
  const { code } = req.body || {};
  if (!code || String(code).trim().length !== 6) {
    return res.status(400).json({ error: 'Informe o código de 6 dígitos do autenticador.' });
  }

  const user = db.prepare('SELECT two_factor_temp_secret FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.two_factor_temp_secret) {
    return res.status(400).json({ error: 'Configuração de 2FA não iniciada. Tente novamente.' });
  }

  const isValid = verifyTOTP(code, user.two_factor_temp_secret);
  if (!isValid) {
    return res.status(400).json({ error: 'Código de 6 dígitos incorreto ou expirado.' });
  }

  db.prepare(`
    UPDATE users
    SET two_factor_enabled = 1, two_factor_secret = two_factor_temp_secret, two_factor_temp_secret = NULL
    WHERE id = ?
  `).run(req.user.id);

  res.json({ success: true, message: 'Autenticação de dois fatores ativada com sucesso!' });
});

app.post('/api/user/2fa/disable', authMiddleware, (req, res) => {
  const { code } = req.body || {};
  const user = db.prepare('SELECT two_factor_secret, two_factor_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.two_factor_enabled) {
    return res.status(400).json({ error: '2FA não está ativado nesta conta.' });
  }

  if (code) {
    const isValid = verifyTOTP(code, user.two_factor_secret);
    if (!isValid) {
      return res.status(400).json({ error: 'Código de 6 dígitos incorreto.' });
    }
  }

  db.prepare(`
    UPDATE users
    SET two_factor_enabled = 0, two_factor_secret = NULL, two_factor_temp_secret = NULL
    WHERE id = ?
  `).run(req.user.id);

  res.json({ success: true, message: 'Autenticação de dois fatores desativada com sucesso.' });
});

app.get('/api/user/organization/settings', authMiddleware, (req, res) => {
  const accountOwnerId = req.user.owner_id || req.user.id;
  const owner = db.prepare('SELECT require_member_2fa FROM users WHERE id = ?').get(accountOwnerId);
  res.json({
    require_member_2fa: Boolean(owner && owner.require_member_2fa),
    isOwnerOrAdmin: !req.user.owner_id || req.user.role === 'owner' || req.user.role === 'admin'
  });
});

app.post('/api/user/organization/require-2fa', authMiddleware, (req, res) => {
  if (req.user.owner_id && req.user.role !== 'admin' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas Administradores podem alterar esta configuração.' });
  }
  const accountOwnerId = req.user.owner_id || req.user.id;
  const { enabled } = req.body || {};
  const val = enabled ? 1 : 0;
  db.prepare('UPDATE users SET require_member_2fa = ? WHERE id = ?').run(val, accountOwnerId);
  res.json({ success: true, require_member_2fa: Boolean(val) });
});

app.get('/api/members', authMiddleware, (req, res) => {
  const accountOwnerId = req.user.owner_id || req.user.id;
  const activeMembers = db.prepare(`
    SELECT id, name, email, role, status, avatar_url, created_at, owner_id, 'active' AS invite_status
    FROM users
    WHERE owner_id = ?
    ORDER BY id ASC
  `).all(accountOwnerId);

  const pendingInvites = db.prepare(`
    SELECT id, name, email, role, 'pending' AS status, NULL AS avatar_url, created_at, owner_id, expires_at, 'pending' AS invite_status
    FROM team_invites
    WHERE owner_id = ? AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    ORDER BY id DESC
  `).all(accountOwnerId);

  res.json({ members: [...activeMembers, ...pendingInvites], accountOwnerId });
});

app.post('/api/members', authMiddleware, async (req, res) => {
  const accountOwnerId = req.user.owner_id || req.user.id;
  if (req.user.owner_id && req.user.role !== 'admin' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas administradores podem convidar membros.' });
  }
  const { name, email, role, permission } = req.body || {};
  const memberName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const memberRole = (permission === 'admin' || role === 'admin') ? 'admin' : 'member';

  if (!memberName || memberName.length < 3) {
    return res.status(400).json({ error: 'O nome deve conter pelo menos 3 caracteres.' });
  }
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return res.status(400).json({ error: 'Informe um e-mail válido.' });
  }

  const existingMember = db.prepare('SELECT id FROM users WHERE email = ? AND owner_id = ?').get(cleanEmail, accountOwnerId);
  if (existingMember) {
    return res.status(400).json({ error: 'Este usuário já faz parte da sua equipe.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.prepare('DELETE FROM team_invites WHERE owner_id = ? AND email = ?').run(accountOwnerId, cleanEmail);

  const info = db.prepare(`
    INSERT INTO team_invites (owner_id, name, email, role, token, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountOwnerId, memberName.slice(0, 60), cleanEmail, memberRole, token, expiresAt);

  const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const baseUrl = DASH_DOMAIN ? `https://${DASH_DOMAIN}` : `${protocol}://${host}`;
  const inviteLink = `${baseUrl}/convite?token=${token}`;

  try {
    const inviter = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
    await sendInviteEmail({
      to: cleanEmail,
      name: memberName,
      inviterName: inviter ? inviter.name : req.user.name,
      inviteLink,
      role: memberRole
    });
  } catch (emailErr) {
    console.error('[CloudVTurb Invite Email Error]', emailErr);
  }

  res.json({ success: true, message: 'Convite enviado com sucesso!', inviteId: info.lastInsertRowid, inviteLink });
});

app.post('/api/invites/:id/resend', authMiddleware, async (req, res) => {
  const accountOwnerId = req.user.owner_id || req.user.id;
  if (req.user.owner_id && req.user.role !== 'admin' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas administradores podem reenviar convites.' });
  }
  const inviteId = parseInt(req.params.id, 10);
  const invite = db.prepare('SELECT * FROM team_invites WHERE id = ? AND owner_id = ?').get(inviteId, accountOwnerId);
  if (!invite) {
    return res.status(404).json({ error: 'Convite não encontrado.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE team_invites SET token = ?, expires_at = ?, accepted_at = NULL WHERE id = ?').run(token, expiresAt, inviteId);

  const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const baseUrl = DASH_DOMAIN ? `https://${DASH_DOMAIN}` : `${protocol}://${host}`;
  const inviteLink = `${baseUrl}/convite?token=${token}`;

  try {
    const inviter = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
    await sendInviteEmail({
      to: invite.email,
      name: invite.name,
      inviterName: inviter ? inviter.name : req.user.name,
      inviteLink,
      role: invite.role
    });
  } catch (emailErr) {
    console.error('[CloudVTurb Resend Invite Error]', emailErr);
  }

  res.json({ success: true, message: 'Convite reenviado com sucesso!' });
});

app.delete('/api/invites/:id', authMiddleware, (req, res) => {
  const accountOwnerId = req.user.owner_id || req.user.id;
  if (req.user.owner_id && req.user.role !== 'admin' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas administradores podem cancelar convites.' });
  }
  const inviteId = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM team_invites WHERE id = ? AND owner_id = ?').run(inviteId, accountOwnerId);
  res.json({ success: true });
});

app.delete('/api/members/:id', authMiddleware, (req, res) => {
  const accountOwnerId = req.user.owner_id || req.user.id;
  if (req.user.owner_id && req.user.role !== 'admin' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas administradores podem remover membros.' });
  }
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Você não pode remover sua própria conta.' });
  }
  if (targetId === accountOwnerId) {
    return res.status(403).json({ error: 'O proprietário da conta não pode ser removido.' });
  }
  const member = db.prepare('SELECT id, owner_id FROM users WHERE id = ?').get(targetId);
  if (!member || member.owner_id !== accountOwnerId) {
    return res.status(404).json({ error: 'Membro não encontrado na sua equipe.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ success: true });
});

app.get('/api/invites/verify', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Token não fornecido.' });

  const invite = db.prepare(`
    SELECT ti.*, u.name as inviter_name, u.email as inviter_email
    FROM team_invites ti
    JOIN users u ON u.id = ti.owner_id
    WHERE ti.token = ?
  `).get(token);

  if (!invite) {
    return res.status(404).json({ error: 'Convite não encontrado ou inválido.' });
  }
  if (invite.accepted_at) {
    return res.status(400).json({ error: 'Este convite já foi aceito anteriormente.' });
  }
  if (new Date(invite.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Este convite expirou. Solicite um novo convite ao administrador.' });
  }

  const existingUser = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(invite.email.toLowerCase());

  res.json({
    valid: true,
    invite: {
      name: invite.name,
      email: invite.email,
      role: invite.role,
      inviterName: invite.inviter_name,
      expiresAt: invite.expires_at,
      userExists: !!existingUser
    }
  });
});

app.post('/api/invites/accept', async (req, res) => {
  const { token, name, password } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token não fornecido.' });

  const invite = db.prepare(`
    SELECT ti.*, u.name as inviter_name
    FROM team_invites ti
    JOIN users u ON u.id = ti.owner_id
    WHERE ti.token = ?
  `).get(token);

  if (!invite) return res.status(404).json({ error: 'Convite inválido ou não encontrado.' });
  if (invite.accepted_at) return res.status(400).json({ error: 'Este convite já foi aceito.' });
  if (new Date(invite.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Este convite expirou (validade de 24 horas).' });
  }

  const cleanEmail = invite.email.toLowerCase();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);

  if (!user) {
    const memberName = String(name || invite.name).trim();
    if (!memberName || memberName.length < 3) {
      return res.status(400).json({ error: 'O nome deve conter pelo menos 3 caracteres.' });
    }
    const cleanPassword = String(password || '');
    if (cleanPassword.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' });
    }
    const hash = bcrypt.hashSync(cleanPassword, 10);
    const nowIso = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, status, onboarding_completed, owner_id, created_at)
      VALUES (?, ?, ?, ?, 'approved', 1, ?, ?)
    `).run(memberName.slice(0, 60), cleanEmail, hash, invite.role, invite.owner_id, nowIso);

    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  } else {
    db.prepare('UPDATE users SET owner_id = ?, role = ?, status = \'approved\' WHERE id = ?').run(invite.owner_id, invite.role, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  db.prepare('UPDATE team_invites SET accepted_at = CURRENT_TIMESTAMP WHERE id = ?').run(invite.id);

  const payload = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    owner_id: user.owner_id
  };
  const authToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    token: authToken,
    user: payload,
    message: 'Convite aceito com sucesso!'
  });
});

app.get('/api/security/domains', authMiddleware, (req, res) => {
  const accountOwnerId = req.user.owner_id || req.user.id;
  const domains = db.prepare(`
    SELECT id, domain, traffic_count, last_session_at, created_at
    FROM allowed_domains
    WHERE user_id = ?
    ORDER BY id DESC
  `).all(accountOwnerId);
  res.json({ domains });
});

app.post('/api/security/domains', authMiddleware, (req, res) => {
  const accountOwnerId = req.user.owner_id || req.user.id;
  if (req.user.owner_id && req.user.role !== 'admin' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas administradores podem gerenciar domínios de segurança.' });
  }
  const { domains } = req.body || {};
  if (!domains || !Array.isArray(domains) || !domains.length) {
    return res.status(400).json({ error: 'Informe ao menos um domínio.' });
  }

  const cleanList = [];
  for (const d of domains) {
    let raw = String(d || '').trim().toLowerCase();
    raw = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
    if (!raw) continue;
    const isValid = /^(\*\.)?([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i.test(raw) || /^localhost(:[0-9]+)?$/i.test(raw);
    if (!isValid) {
      return res.status(400).json({ error: `Domínio inválido: "${raw}". Use o formato example.com ou *.example.com.` });
    }
    cleanList.push(raw);
  }

  if (!cleanList.length) {
    return res.status(400).json({ error: 'Informe ao menos um domínio válido.' });
  }

  const insertStmt = db.prepare('INSERT INTO allowed_domains (user_id, domain) VALUES (?, ?)');
  let added = 0;
  for (const domain of cleanList) {
    const exists = db.prepare('SELECT id FROM allowed_domains WHERE user_id = ? AND domain = ?').get(accountOwnerId, domain);
    if (!exists) {
      insertStmt.run(accountOwnerId, domain);
      added++;
    }
  }

  res.json({
    success: true,
    count: added,
    message: 'As configurações de domínio foram atualizadas com sucesso'
  });
});

app.put('/api/security/domains/:id', authMiddleware, (req, res) => {
  const accountOwnerId = req.user.owner_id || req.user.id;
  if (req.user.owner_id && req.user.role !== 'admin' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas administradores podem gerenciar domínios.' });
  }
  const id = parseInt(req.params.id, 10);
  let { domain } = req.body || {};
  domain = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  const isValid = /^(\*\.)?([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i.test(domain) || /^localhost(:[0-9]+)?$/i.test(domain);
  if (!isValid) {
    return res.status(400).json({ error: 'Domínio inválido. Use o formato example.com ou *.example.com.' });
  }

  const existing = db.prepare('SELECT id FROM allowed_domains WHERE id = ? AND user_id = ?').get(id, accountOwnerId);
  if (!existing) {
    return res.status(404).json({ error: 'Domínio não encontrado.' });
  }

  db.prepare('UPDATE allowed_domains SET domain = ? WHERE id = ?').run(domain, id);
  res.json({ success: true, message: 'Domínio atualizado com sucesso' });
});

app.delete('/api/security/domains/:id', authMiddleware, (req, res) => {
  const accountOwnerId = req.user.owner_id || req.user.id;
  if (req.user.owner_id && req.user.role !== 'admin' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas administradores podem remover domínios.' });
  }
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM allowed_domains WHERE id = ? AND user_id = ?').run(id, accountOwnerId);
  res.json({ success: true, message: 'Domínio removido com sucesso' });
});

app.get('/api/security/check-domain', (req, res) => {
  const videoId = req.query.video_id;
  const originDomain = String(req.query.domain || '').trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  if (!videoId) return res.json({ allowed: true });
  const video = db.prepare('SELECT user_id FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.json({ allowed: true });

  const user = db.prepare('SELECT id, owner_id FROM users WHERE id = ?').get(video.user_id);
  const ownerId = (user && user.owner_id) || video.user_id;

  const domains = db.prepare('SELECT id, domain FROM allowed_domains WHERE user_id = ?').all(ownerId);
  if (!domains.length) {
    return res.json({ allowed: true });
  }

  if (!originDomain) {
    return res.json({ allowed: false, message: 'Execução restrita aos domínios autorizados.' });
  }

  let matchedDomain = null;
  for (const d of domains) {
    const pattern = d.domain.toLowerCase();
    if (pattern === originDomain) {
      matchedDomain = d;
      break;
    }
    if (pattern.startsWith('*.')) {
      const root = pattern.slice(2);
      if (originDomain === root || originDomain.endsWith('.' + root)) {
        matchedDomain = d;
        break;
      }
    }
  }

  if (matchedDomain) {
    try {
      db.prepare('UPDATE allowed_domains SET traffic_count = traffic_count + 1, last_session_at = CURRENT_TIMESTAMP WHERE id = ?').run(matchedDomain.id);
    } catch (e) {}
    return res.json({ allowed: true });
  }

  return res.json({ allowed: false, message: 'Domínio não autorizado. Este vídeo só pode ser executado nos domínios permitidos pelo proprietário.' });
});

app.get('/api/storage/details', authMiddleware, (req, res) => {
  const isOwner = req.user.role === 'owner';

  try {
    const localVideos = isOwner
      ? db.prepare("SELECT id, file_path, file_size, duration FROM videos WHERE source_type = 'local'").all()
      : db.prepare("SELECT id, file_path, file_size, duration FROM videos WHERE user_id = ? AND source_type = 'local'").all(req.user.id);
    for (const lv of localVideos) {
      let fPath = lv.file_path;
      if (fPath && !fs.existsSync(fPath)) {
        const altPath = path.join(VIDEOS_DIR, path.basename(fPath));
        if (fs.existsSync(altPath)) fPath = altPath;
      }
      let currentSize = 0;
      if (fPath && fs.existsSync(fPath)) {
        try { currentSize = fs.statSync(fPath).size; } catch (e) {}
      }
      const hlsDir = path.join(VIDEOS_DIR, lv.id);
      if (fs.existsSync(hlsDir)) {
        try {
          const subFiles = fs.readdirSync(hlsDir);
          for (const sf of subFiles) {
            try { currentSize += fs.statSync(path.join(hlsDir, sf)).size; } catch (e) {}
          }
        } catch (e) {}
      }

      if (currentSize > 0 && lv.file_size !== currentSize) {
        db.prepare('UPDATE videos SET file_size = ? WHERE id = ?').run(currentSize, lv.id);
        lv.file_size = currentSize;
      }

      if (fPath && (!lv.duration || lv.duration === '10:00' || lv.duration === '05:00')) {
        const realDur = getVideoDurationFormatted(fPath);
        if (realDur) {
          db.prepare('UPDATE videos SET duration = ? WHERE id = ?').run(realDur, lv.id);
          lv.duration = realDur;
        }
      }
    }
  } catch (e) {}

  let rawVideos = [];
  if (isOwner) {
    rawVideos = db.prepare(`
      SELECT v.id, v.title, v.duration, v.file_size, v.source_type, v.created_at, v.deleted_at,
             v.blocked_at, v.blocked_reason, v.video_url,
             v.user_id, u.name as user_name, u.email as user_email, u.role as user_role,
             f.name as folder_name
      FROM videos v
      LEFT JOIN users u ON u.id = v.user_id
      LEFT JOIN folders f ON f.id = v.folder_id
      WHERE v.source_type = 'local' OR v.file_size > 0
      ORDER BY v.file_size DESC, v.created_at DESC
    `).all();
  } else {
    rawVideos = db.prepare(`
      SELECT v.id, v.title, v.duration, v.file_size, v.source_type, v.created_at, v.deleted_at,
             v.blocked_at, v.blocked_reason, v.video_url,
             v.user_id,
             f.name as folder_name
      FROM videos v
      LEFT JOIN folders f ON f.id = v.folder_id
      WHERE v.user_id = ? AND (v.source_type = 'local' OR v.file_size > 0)
      ORDER BY v.file_size DESC, v.created_at DESC
    `).all(req.user.id);
  }

  const totalLimitBytes = isOwner ? SERVER_STORAGE_LIMIT_BYTES : MEMBER_STORAGE_LIMIT_BYTES;
  const usedBytes = isOwner ? getUsedStorageBytes() : getUserStorageBytes(req.user.id);
  const freeBytes = Math.max(0, totalLimitBytes - usedBytes);
  const percent = totalLimitBytes > 0 ? (usedBytes / totalLimitBytes) * 100 : 0;

  const formattedVideos = rawVideos.map(v => {
    const sizeBytes = Number(v.file_size || 0);
    const rawPct = totalLimitBytes > 0 ? (sizeBytes / totalLimitBytes) * 100 : 0;
    const pctOfTotal = rawPct > 0 && rawPct < 0.01 ? '< 0.01' : rawPct.toFixed(2);
    const pctOfUsed = usedBytes > 0 ? ((sizeBytes / usedBytes) * 100).toFixed(1) : '0.0';
    return {
      id: v.id,
      title: v.title,
      userId: v.user_id,
      videoUrl: v.video_url || '',
      isBlocked: !!v.blocked_at,
      blockedAt: v.blocked_at,
      blockedReason: v.blocked_reason,
      duration: v.duration || '00:00',
      sizeBytes,
      sizeFormatted: v.source_type === 'remote' && sizeBytes === 0 ? 'Remoto (0 MB)' : formatStorage(sizeBytes),
      pctOfTotal,
      pctOfUsed,
      sourceType: v.source_type || 'local',
      folderName: v.folder_name || 'Raiz',
      isTrash: !!v.deleted_at,
      createdAt: v.created_at,
      userName: v.user_name || null,
      userEmail: v.user_email || null,
      userRole: v.user_role || null
    };
  });

  res.json({
    scope: isOwner ? 'global' : 'individual',
    isOwner,
    totalBytes: totalLimitBytes,
    totalFormatted: isOwner ? '30 GB' : '3 GB',
    usedBytes,
    formattedUsage: formatStorage(usedBytes),
    freeBytes,
    formattedFree: formatStorage(freeBytes),
    usagePercent: percent < 0.1 && usedBytes > 0 ? '0.1' : percent.toFixed(1),
    videosCount: rawVideos.length,
    activeVideosCount: rawVideos.filter(v => !v.deleted_at && !v.blocked_at).length,
    blockedVideosCount: rawVideos.filter(v => !v.deleted_at && !!v.blocked_at).length,
    trashVideosCount: rawVideos.filter(v => !!v.deleted_at).length,
    averageSizeBytes: rawVideos.length > 0 ? Math.round(usedBytes / rawVideos.length) : 0,
    averageSizeFormatted: rawVideos.length > 0 ? formatStorage(Math.round(usedBytes / rawVideos.length)) : '0 MB',
    videos: formattedVideos
  });
});

app.get('/api/keys', authMiddleware, (req, res) => {
  const key = db.prepare(`
    SELECT id, name, key_prefix, token, created_at, last_used_at
    FROM api_keys
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(req.user.id);
  res.json({ key: key || null, keys: key ? [key] : [] });
});

app.post('/api/keys', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(req.user.id);
  const rawKey = crypto.randomBytes(32).toString('hex');
  const keyPrefix = rawKey.slice(0, 8) + '••••' + rawKey.slice(-4);
  const keyHash = bcrypt.hashSync(rawKey, 8);
  const keyId = 'key_' + Date.now();
  const keyName = 'Chave de API';

  db.prepare(`
    INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, token)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(keyId, req.user.id, keyName, keyPrefix, keyHash, rawKey);

  res.json({
    success: true,
    key: {
      id: keyId,
      name: keyName,
      token: rawKey,
      keyPrefix,
      createdAt: new Date().toISOString()
    }
  });
});

app.delete('/api/keys/:id?', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

function generateWebhookSecret() {
  return 'whsec_' + crypto.randomBytes(16).toString('hex');
}

function generateEventId() {
  return 'evt_' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}

async function dispatchWebhookEvent(userId, eventType, data) {
  if (!userId) return;
  try {
    const hooks = db.prepare(`
      SELECT id, url, events_json, secret
      FROM webhooks
      WHERE user_id = ? AND is_active = 1
    `).all(userId);

    for (const hook of hooks) {
      let events = [];
      try { events = JSON.parse(hook.events_json || '[]'); } catch (e) {}
      if (!events.includes(eventType)) continue;

      const eventId = generateEventId();
      const payload = {
        event_id: eventId,
        event_type: eventType,
        v: 1,
        org_id: String(userId),
        occurred_at: new Date().toISOString(),
        data: data || {}
      };

      const payloadStr = JSON.stringify(payload);

      (async () => {
        const deliveryId = 'del_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        let statusCode = null;
        let responseBody = null;
        let success = 0;

        try {
          const res = await fetch(hook.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'user-agent': 'VTurb-Webhooks/1.0',
              'webhook-id': eventId,
              'webhook-signature': hook.secret
            },
            body: payloadStr,
            signal: AbortSignal.timeout(8000)
          });

          statusCode = res.status;
          success = (statusCode >= 200 && statusCode < 300) ? 1 : 0;
          try {
            responseBody = (await res.text()).slice(0, 1000);
          } catch (e) {}
        } catch (err) {
          responseBody = err.message;
        }

        try {
          db.prepare(`
            INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status_code, response_body, success)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(deliveryId, hook.id, eventId, eventType, payloadStr, statusCode, responseBody, success);
        } catch (e) {}
      })();
    }
  } catch (err) {}
}

app.get('/api/webhooks/generate-secret', authMiddleware, (req, res) => {
  res.json({ secret: generateWebhookSecret() });
});

app.get('/api/webhooks', authMiddleware, (req, res) => {
  const hooks = db.prepare(`
    SELECT id, url, events_json, secret, is_active, created_at
    FROM webhooks
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(req.user.id);

  const parsed = hooks.map(h => ({
    id: h.id,
    url: h.url,
    events: JSON.parse(h.events_json || '[]'),
    secret: h.secret,
    isActive: h.is_active,
    created_at: h.created_at
  }));
  res.json({ webhooks: parsed });
});

app.post('/api/webhooks', authMiddleware, (req, res) => {
  const { url, events, secret } = req.body || {};
  if (!url || typeof url !== 'string' || (!url.startsWith('https://') && !url.startsWith('http://'))) {
    return res.status(400).json({ error: 'URL do webhook inválida. Deve começar com https://' });
  }

  const cleanUrl = url.trim();
  const hookId = 'whk_' + Date.now();
  const cleanSecret = (secret && typeof secret === 'string' && secret.startsWith('whsec_'))
    ? secret.trim()
    : generateWebhookSecret();

  const allowedEvents = [
    'video.upload.completed',
    'video.created',
    'video.processing',
    'video.ready',
    'video.failed',
    'video.updated',
    'video.deleted'
  ];

  const eventsArray = Array.isArray(events) && events.length > 0
    ? events.filter(e => allowedEvents.includes(e))
    : allowedEvents;

  db.prepare(`
    INSERT INTO webhooks (id, user_id, url, events_json, secret, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(hookId, req.user.id, cleanUrl, JSON.stringify(eventsArray), cleanSecret);

  res.json({
    success: true,
    webhook: {
      id: hookId,
      url: cleanUrl,
      events: eventsArray,
      secret: cleanSecret,
      isActive: 1,
      createdAt: new Date().toISOString()
    }
  });
});

app.delete('/api/webhooks/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

app.post('/api/webhooks/:id/test', authMiddleware, async (req, res) => {
  const hook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!hook) return res.status(404).json({ error: 'Webhook não encontrado.' });

  const eventId = generateEventId();
  const testPayload = {
    event_id: eventId,
    event_type: 'video.upload.completed',
    v: 1,
    org_id: String(req.user.id),
    occurred_at: new Date().toISOString(),
    data: {
      video_id: 'vid_' + Date.now().toString(36),
      name: 'video-teste-vturb.mp4',
      size_bytes: 14820914,
      source: 'dashboard'
    }
  };

  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'VTurb-Webhooks/1.0',
        'webhook-id': eventId,
        'webhook-signature': hook.secret
      },
      body: JSON.stringify(testPayload),
      signal: AbortSignal.timeout(10000)
    });

    const isSuccess = response.status >= 200 && response.status < 300;
    res.json({
      success: isSuccess,
      httpStatus: response.status,
      statusText: response.statusText,
      eventId
    });
  } catch (err) {
    res.status(502).json({ error: 'Falha ao enviar webhook de teste: ' + err.message });
  }
});

app.get('/api/folders', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, COUNT(v.id) as video_count
    FROM folders f
    LEFT JOIN videos v ON v.folder_id = f.id AND v.deleted_at IS NULL
    WHERE f.user_id = ?
    GROUP BY f.id
    ORDER BY f.created_at DESC
  `).all(req.user.id);
  res.json({ folders: rows });
});

app.post('/api/folders', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'O nome da pasta é obrigatório.' });
  }

  const cleanName = name.trim().slice(0, 35);
  const folderId = 'fld_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

  db.prepare(`
    INSERT INTO folders (id, user_id, name)
    VALUES (?, ?, ?)
  `).run(folderId, req.user.id, cleanName);

  res.json({ success: true, folder: { id: folderId, name: cleanName, user_id: req.user.id, video_count: 0 } });
});

app.put('/api/folders/:id', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Nome inválido.' });
  }

  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Pasta não encontrada.' });
  if (req.user.role !== 'owner' && folder.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  const cleanName = name.trim().slice(0, 35);
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(cleanName, req.params.id);
  res.json({ success: true, name: cleanName });
});

app.delete('/api/folders/:id', authMiddleware, (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Pasta não encontrada.' });
  if (req.user.role !== 'owner' && folder.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  db.prepare('UPDATE videos SET folder_id = NULL WHERE folder_id = ?').run(req.params.id);
  db.prepare('DELETE FROM folders WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/videos', authMiddleware, (req, res) => {
  const isTrash = req.query.trash === '1';
  const folderId = req.query.folder_id;

  let query = 'SELECT * FROM videos WHERE ';
  const params = [];

  if (isTrash) {
    query += 'deleted_at IS NOT NULL ';
  } else {
    query += 'deleted_at IS NULL ';
  }

  query += 'AND user_id = ? ';
  params.push(req.user.id);

  if (folderId) {
    if (folderId === 'root') {
      query += 'AND (folder_id IS NULL OR folder_id = "") ';
    } else {
      query += 'AND folder_id = ? ';
      params.push(folderId);
    }
  }

  query += 'ORDER BY created_at DESC';

  const origin = PLAYER_DOMAIN ? `https://${PLAYER_DOMAIN}` : `${req.protocol}://${req.get('host')}`;
  const rows = db.prepare(query).all(...params);
  const videos = rows.map(r => {
    let settings = {};
    try { settings = r.settings_json ? JSON.parse(r.settings_json) : {}; } catch (e) {}
    const posterPath = path.join(VIDEOS_DIR, r.id, 'poster.jpg');
    const posterUrl = fs.existsSync(posterPath) ? `${origin}/videos/${r.id}/poster.jpg` : (settings.thumbnailUrl || (r.video_url ? `${r.video_url}#t=0.5` : null));

    let fileSize = Number(r.file_size || 0);
    let resolvedPath = r.file_path;
    if ((!resolvedPath || !fs.existsSync(resolvedPath)) && r.video_url) {
      const candidate = path.join(VIDEOS_DIR, path.basename(r.video_url));
      if (fs.existsSync(candidate)) resolvedPath = candidate;
    }

    if (fileSize === 0) {
      if (resolvedPath && fs.existsSync(resolvedPath)) {
        try { fileSize = fs.statSync(resolvedPath).size; } catch (e) {}
      }
      const hlsDir = path.join(VIDEOS_DIR, r.id);
      if (fs.existsSync(hlsDir)) {
        try {
          const files = fs.readdirSync(hlsDir);
          let hlsTotal = 0;
          for (const f of files) {
            try { hlsTotal += fs.statSync(path.join(hlsDir, f)).size; } catch (e) {}
          }
          if (hlsTotal > fileSize) fileSize = hlsTotal;
        } catch (e) {}
      }
      if (fileSize > 0) {
        try { db.prepare('UPDATE videos SET file_size = ? WHERE id = ?').run(fileSize, r.id); } catch (e) {}
      }
    }

    let duration = r.duration;
    if ((!duration || duration === '10:00' || duration === '05:00') && resolvedPath && fs.existsSync(resolvedPath)) {
      try {
        const probed = getVideoDurationFormatted(resolvedPath);
        if (probed) {
          duration = probed;
          db.prepare('UPDATE videos SET duration = ? WHERE id = ?').run(duration, r.id);
        }
      } catch (e) {}
    }

    return {
      ...r,
      duration,
      file_size: fileSize,
      settings,
      poster_url: posterUrl,
      thumbnail: posterUrl
    };
  });

  res.json({ videos });
});

app.get('/api/videos/top', authMiddleware, (req, res) => {
  const origin = PLAYER_DOMAIN ? `https://${PLAYER_DOMAIN}` : `${req.protocol}://${req.get('host')}`;
  const videosQuery = 'SELECT id, title, video_url, duration, plays, settings_json, hls_ready, hls_manifest, created_at FROM videos WHERE deleted_at IS NULL AND user_id = ? ORDER BY plays DESC LIMIT 20';
  const rows = db.prepare(videosQuery).all(req.user.id);
  const topVideos = rows.map(v => {
    let settings = {};
    try { if (v.settings_json) settings = JSON.parse(v.settings_json); } catch (e) {}
    const posterPath = path.join(VIDEOS_DIR, v.id, 'poster.jpg');
    const posterUrl = fs.existsSync(posterPath) ? `${origin}/videos/${v.id}/poster.jpg` : (settings.thumbnailUrl || (v.video_url ? `${v.video_url}#t=0.5` : null));
    const ctaClicks = db.prepare("SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'cta_clicked'").get(v.id).count;
    const completes = db.prepare("SELECT COUNT(DISTINCT session_id) as count FROM analytics_events WHERE video_id = ? AND (event_type = 'complete' OR (event_type = 'progress' AND milestone = 100))").get(v.id).count;
    const completionRate = v.plays > 0 ? ((completes / v.plays) * 100).toFixed(1) : '0.0';
    const ctaRate = v.plays > 0 ? ((ctaClicks / v.plays) * 100).toFixed(1) : '0.0';

    return {
      id: v.id,
      title: v.title,
      video_url: v.video_url,
      poster_url: posterUrl,
      thumbnail: posterUrl,
      duration: v.duration,
      plays: v.plays || 0,
      hls_ready: Boolean(v.hls_ready),
      hls_manifest: v.hls_manifest || null,
      ctaClicks,
      completes,
      completionRate,
      ctaRate,
      createdAt: v.created_at
    };
  });

  res.json({ topVideos });
});

app.post('/api/videos', authMiddleware, (req, res) => {
  const { id, title, videoUrl, sourceType, filePath, duration, settings, fileSize, folderId } = req.body;

  if (!videoUrl || typeof videoUrl !== 'string') {
    return res.status(400).json({ error: 'URL do vídeo é obrigatória.' });
  }

  const cleanUrl = videoUrl.trim();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://') && !cleanUrl.startsWith('/videos/')) {
    return res.status(400).json({ error: 'URL do vídeo inválida.' });
  }

  const vidId = id && /^[a-zA-Z0-9_-]+$/.test(id) ? id : 'vsl_' + Date.now();
  const cleanTitle = (title || 'Minha VSL').trim().slice(0, 70);

  let resolvedSize = 0;
  if (sourceType === 'local') {
    if (fileSize && typeof fileSize === 'number') {
      resolvedSize = fileSize;
    } else if (filePath && fs.existsSync(filePath)) {
      try { resolvedSize = fs.statSync(filePath).size; } catch (e) {}
    }
  }

  let cleanFolderId = null;
  if (folderId && folderId !== 'root') {
    const folder = db.prepare('SELECT id, user_id FROM folders WHERE id = ?').get(folderId);
    if (folder && (req.user.role === 'owner' || folder.user_id === req.user.id)) {
      cleanFolderId = folder.id;
    }
  }

  let resolvedDuration = duration;
  if ((!resolvedDuration || resolvedDuration === '10:00' || resolvedDuration === '05:00') && filePath) {
    resolvedDuration = getVideoDurationFormatted(filePath);
  }

  const initialStatus = sourceType === 'local' ? 'optimizing' : 'ready';
  const initialProgress = sourceType === 'local' ? 15 : 100;
  db.prepare(`
    INSERT INTO videos (id, user_id, folder_id, title, source_type, file_path, file_size, video_url, duration, settings_json, status, optimization_progress)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vidId,
    req.user.id,
    cleanFolderId,
    cleanTitle,
    sourceType === 'local' ? 'local' : 'remote',
    filePath || null,
    resolvedSize,
    cleanUrl,
    resolvedDuration || null,
    JSON.stringify(settings || {}),
    initialStatus,
    initialProgress
  );

  if (sourceType === 'local' && filePath) {
    processVideoHLS(vidId);
    dispatchWebhookEvent(req.user.id, 'video.upload.completed', {
      video_id: vidId,
      name: cleanTitle,
      size_bytes: resolvedSize,
      source: 'dashboard'
    });
  }

  dispatchWebhookEvent(req.user.id, 'video.created', {
    video_id: vidId,
    name: cleanTitle,
    size_bytes: resolvedSize,
    source: sourceType === 'local' ? 'dashboard' : 'remote'
  });

  res.json({ success: true, id: vidId });
});

app.patch('/api/videos/:id/move', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const { folderId } = req.body || {};

  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  let cleanFolderId = null;
  if (folderId && folderId !== 'root') {
    const folder = db.prepare('SELECT id, user_id FROM folders WHERE id = ?').get(folderId);
    if (!folder) return res.status(404).json({ error: 'Pasta de destino não encontrada.' });
    if (req.user.role !== 'owner' && folder.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Pasta não pertence a você.' });
    }
    cleanFolderId = folder.id;
  }

  db.prepare('UPDATE videos SET folder_id = ? WHERE id = ?').run(cleanFolderId, vidId);
  res.json({ success: true, folderId: cleanFolderId });
});

app.patch('/api/videos/:id/trash', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  db.prepare('UPDATE videos SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(vidId);
  dispatchWebhookEvent(existing.user_id, 'video.deleted', {
    video_id: vidId,
    name: existing.title || ''
  });
  res.json({ success: true });
});

app.patch('/api/videos/:id/restore', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  db.prepare('UPDATE videos SET deleted_at = NULL WHERE id = ?').run(vidId);
  res.json({ success: true });
});

app.get('/api/videos/:id', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const v = db.prepare('SELECT * FROM videos WHERE id = ? AND deleted_at IS NULL').get(vidId);
  if (!v) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && v.user_id !== req.user.id) return res.status(403).json({ error: 'Permissão negada.' });

  let settings = {};
  try { settings = v.settings_json ? JSON.parse(v.settings_json) : {}; } catch (e) {}
  const origin = PLAYER_DOMAIN ? `https://${PLAYER_DOMAIN}` : `${req.protocol}://${req.get('host')}`;
  const posterPath = path.join(VIDEOS_DIR, v.id, 'poster.jpg');
  const posterUrl = fs.existsSync(posterPath) ? `${origin}/videos/${v.id}/poster.jpg` : (settings.thumbnailUrl || (v.video_url ? `${v.video_url}#t=0.5` : null));

  res.json({
    video: {
      ...v,
      settings,
      poster_url: posterUrl,
      thumbnail: posterUrl
    }
  });
});

const updateVideoHandler = (req, res) => {
  const { title, settings, duration, folderId } = req.body;
  const vidId = req.params.id;

  const existing = db.prepare('SELECT user_id, status FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }
  if (existing.status === 'optimizing') {
    return res.status(400).json({ error: 'Este vídeo ainda está sendo otimizado. Aguarde a conclusão para editá-lo.' });
  }

  let cleanFolderId = existing.folder_id;
  if (folderId !== undefined) {
    if (!folderId || folderId === 'root') {
      cleanFolderId = null;
    } else {
      const folder = db.prepare('SELECT id, user_id FROM folders WHERE id = ?').get(folderId);
      if (folder && (req.user.role === 'owner' || folder.user_id === req.user.id)) {
        cleanFolderId = folder.id;
      }
    }
  }

  db.prepare(`
    UPDATE videos SET
      title = COALESCE(?, title),
      duration = COALESCE(?, duration),
      settings_json = COALESCE(?, settings_json),
      folder_id = ?
    WHERE id = ?
  `).run(
    title ? title.trim().slice(0, 70) : null,
    duration || null,
    settings ? JSON.stringify(settings) : null,
    cleanFolderId,
    vidId
  );

  dispatchWebhookEvent(existing.user_id, 'video.updated', {
    video_id: vidId,
    name: title || ''
  });

  res.json({ success: true });
};

app.put('/api/videos/:id', authMiddleware, updateVideoHandler);
app.patch('/api/videos/:id', authMiddleware, updateVideoHandler);

app.post('/api/videos/:id/duplicate', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  const newId = 'vsl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const newTitle = `${existing.title || 'Vídeo'} (Cópia)`.slice(0, 70);

  db.prepare(`
    INSERT INTO videos (id, user_id, folder_id, title, source_type, file_path, file_size, video_url, duration, settings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId,
    existing.user_id,
    existing.folder_id,
    newTitle,
    existing.source_type,
    existing.file_path,
    existing.file_size,
    existing.video_url,
    existing.duration,
    existing.settings_json
  );

  dispatchWebhookEvent(existing.user_id, 'video.created', {
    video_id: newId,
    name: newTitle,
    size_bytes: existing.file_size || 0,
    source: 'duplicate'
  });

  res.json({ success: true, id: newId });
});

app.get('/api/videos/:id/download', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && video.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  const rawTitle = (video.title || 'video').trim().replace(/[/\\?%*:|"<>]/g, '_');
  const downloadName = `${rawTitle}.mp4`;

  if (video.file_path && fs.existsSync(video.file_path)) {
    return res.download(video.file_path, downloadName);
  }

  if (video.video_url) {
    const cleanUrl = video.video_url.split('?')[0].split('#')[0];
    const baseName = path.basename(cleanUrl);
    const candidate1 = path.join(VIDEOS_DIR, baseName);
    if (fs.existsSync(candidate1)) {
      return res.download(candidate1, downloadName);
    }
    const candidate2 = path.join(VIDEOS_DIR, video.id, baseName);
    if (fs.existsSync(candidate2)) {
      return res.download(candidate2, downloadName);
    }
    const dirCandidate = path.join(VIDEOS_DIR, video.id);
    if (fs.existsSync(dirCandidate)) {
      try {
        const files = fs.readdirSync(dirCandidate);
        const mp4File = files.find(f => f.endsWith('.mp4'));
        if (mp4File) {
          return res.download(path.join(dirCandidate, mp4File), downloadName);
        }
      } catch (e) {}
    }
  }

  if (video.video_url && (video.video_url.startsWith('http://') || video.video_url.startsWith('https://'))) {
    return res.redirect(video.video_url);
  }

  res.status(404).json({ error: 'Arquivo de vídeo não encontrado no servidor.' });
});

app.delete('/api/videos/:id', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  db.prepare('UPDATE videos SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(vidId);
  res.json({ success: true, movedToTrash: true });
});

app.delete('/api/videos/:id/permanent', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  if (existing.source_type === 'local' && existing.file_path && fs.existsSync(existing.file_path)) {
    try { fs.unlinkSync(existing.file_path); } catch (e) {}
  }

  const hlsDir = path.join(VIDEOS_DIR, vidId);
  if (fs.existsSync(hlsDir)) {
    try { fs.rmSync(hlsDir, { recursive: true, force: true }); } catch (e) {}
  }

  db.prepare('DELETE FROM analytics_events WHERE video_id = ?').run(vidId);
  db.prepare('DELETE FROM videos WHERE id = ?').run(vidId);
  res.json({ success: true, permanentlyDeleted: true });
});

app.delete('/api/videos/trash/empty', authMiddleware, (req, res) => {
  const isOwner = req.user.role === 'owner';
  const query = isOwner
    ? 'SELECT id, source_type, file_path FROM videos WHERE deleted_at IS NOT NULL'
    : 'SELECT id, source_type, file_path FROM videos WHERE deleted_at IS NOT NULL AND user_id = ?';
  const trashItems = isOwner ? db.prepare(query).all() : db.prepare(query).all(req.user.id);

  if (trashItems.length === 0) {
    return res.json({ success: true, deletedCount: 0 });
  }

  for (const item of trashItems) {
    if (item.source_type === 'local' && item.file_path && fs.existsSync(item.file_path)) {
      try { fs.unlinkSync(item.file_path); } catch (e) {}
    }
    const hlsDir = path.join(VIDEOS_DIR, item.id);
    if (fs.existsSync(hlsDir)) {
      try { fs.rmSync(hlsDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  const ids = trashItems.map(i => i.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM analytics_events WHERE video_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM videos WHERE id IN (${placeholders})`).run(...ids);

  res.json({ success: true, deletedCount: trashItems.length });
});

app.post('/api/videos/:id/moderate', authMiddleware, async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o proprietário do sistema pode moderar vídeos.' });
  }

  const vidId = req.params.id;
  const { action, reason } = req.body || {};

  if (!['block', 'unblock', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'Ação de moderação inválida.' });
  }

  const cleanReason = (reason || '').trim();
  if ((action === 'block' || action === 'delete') && !cleanReason) {
    return res.status(400).json({ error: 'É obrigatório informar o motivo antes de prosseguir.' });
  }

  const video = db.prepare(`
    SELECT v.*, u.name as user_name, u.email as user_email
    FROM videos v
    LEFT JOIN users u ON u.id = v.user_id
    WHERE v.id = ?
  `).get(vidId);

  if (!video) {
    return res.status(404).json({ error: 'Vídeo não encontrado.' });
  }

  const userEmail = video.user_email;
  const userName = video.user_name || 'Usuário';
  const videoTitle = video.title || 'Vídeo';

  try {
    if (action === 'block') {
      db.prepare('UPDATE videos SET blocked_at = CURRENT_TIMESTAMP, blocked_reason = ? WHERE id = ?').run(cleanReason, vidId);
    } else if (action === 'unblock') {
      db.prepare('UPDATE videos SET blocked_at = NULL, blocked_reason = NULL WHERE id = ?').run(vidId);
    } else if (action === 'delete') {
      if (video.source_type === 'local' && video.file_path && fs.existsSync(video.file_path)) {
        try { fs.unlinkSync(video.file_path); } catch (e) {}
      }
      const hlsDir = path.join(VIDEOS_DIR, vidId);
      if (fs.existsSync(hlsDir)) {
        try { fs.rmSync(hlsDir, { recursive: true, force: true }); } catch (e) {}
      }
      db.prepare('UPDATE videos SET deleted_at = CURRENT_TIMESTAMP, file_size = 0, blocked_reason = ? WHERE id = ?').run(cleanReason, vidId);
    }

    if (userEmail) {
      try {
        await sendVideoModerationEmail({
          to: userEmail,
          name: userName,
          videoTitle,
          action,
          reason: cleanReason || (action === 'unblock' ? 'Vídeo desbloqueado pela administração.' : '')
        });
      } catch (mailErr) {
        console.error('[CloudVTurb Moderation Mail Error]', mailErr);
      }
    }

    res.json({
      success: true,
      action,
      message: action === 'block'
        ? 'Vídeo bloqueado com sucesso e notificação enviada por e-mail.'
        : action === 'delete'
        ? 'Vídeo excluído com sucesso e notificação enviada por e-mail.'
        : 'Vídeo desbloqueado com sucesso.'
    });
  } catch (err) {
    console.error('[CloudVTurb Moderate Error]', err);
    res.status(500).json({ error: 'Erro ao processar moderação do vídeo.' });
  }
});

app.post('/api/videos/:id/reprocess', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  if (!existing.file_path || !fs.existsSync(existing.file_path)) {
    return res.status(400).json({ error: 'Arquivo fonte não disponível para transcodificação.' });
  }

  processVideoHLS(vidId);
  res.json({ success: true, message: 'Processamento HLS iniciado.' });
});

app.post('/api/videos/:id/play', (req, res) => {
  const vidId = req.params.id;
  try {
    db.prepare(`
      UPDATE videos
      SET plays = (
        SELECT COUNT(*)
        FROM analytics_events
        WHERE video_id = ? AND event_type = 'play'
      )
      WHERE id = ?
    `).run(vidId, vidId);
    const updated = db.prepare('SELECT plays FROM videos WHERE id = ?').get(vidId);
    res.json({ success: true, plays: updated ? updated.plays : 0 });
  } catch (e) {
    res.json({ success: false });
  }
});

app.get('/api/videos/:id/public', (req, res) => {
  const vidId = req.params.id;
  try {
    const v = db.prepare('SELECT id, title, video_url, duration, settings_json, hls_ready, hls_manifest, smartautoplay_url, blocked_at, blocked_reason, user_id FROM videos WHERE id = ? AND deleted_at IS NULL').get(vidId);
    if (!v) return res.status(404).json({ error: 'Vídeo não encontrado ou indisponível.' });

    if (!v.hls_ready) {
      const videoDir = path.join(VIDEOS_DIR, vidId);
      const masterPlaylist = path.join(videoDir, 'main.m3u8');
      if (fs.existsSync(masterPlaylist)) {
        const manifestUrl = `/videos/${vidId}/main.m3u8`;
        try {
          db.prepare('UPDATE videos SET hls_ready = 1, hls_manifest = ? WHERE id = ?').run(manifestUrl, vidId);
          v.hls_ready = 1;
          v.hls_manifest = manifestUrl;
        } catch (e) {}
      } else {
        processVideoHLS(vidId);
      }
    }

    const token = req.query.token || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : null);
    let isOwnerPreview = false;

    if (token) {
      try {
        const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
        if (session) {
          const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(session.user_id);
          if (user && (user.role === 'owner' || user.id === v.user_id)) {
            isOwnerPreview = true;
          }
        }
      } catch (e) {}
    }

    if (v.blocked_at && !isOwnerPreview) {
      return res.status(403).json({ error: 'Vídeo bloqueado pela moderação.', blocked: true, reason: v.blocked_reason });
    }

    let settings = {};
    try { settings = JSON.parse(v.settings_json || '{}'); } catch (e) {}

    const origin = PLAYER_DOMAIN ? `https://${PLAYER_DOMAIN}` : `${req.protocol}://${req.get('host')}`;

    let videoUrl = v.video_url;
    if (videoUrl && videoUrl.startsWith('/videos/')) {
      videoUrl = `${origin}${videoUrl}`;
    } else if (videoUrl && PLAYER_DOMAIN && videoUrl.includes('/videos/') && !videoUrl.includes(`${PLAYER_DOMAIN}/videos/`)) {
      videoUrl = videoUrl.replace(/^https?:\/\/[^\/]+(\/videos\/)/, `https://${PLAYER_DOMAIN}$1`);
    }

    let hlsUrl = null;
    if (v.hls_ready && v.hls_manifest) {
      hlsUrl = `${origin}${v.hls_manifest}`;
    }

    let smartautoplayUrl = null;
    if (v.smartautoplay_url) {
      smartautoplayUrl = `${origin}${v.smartautoplay_url}`;
    }

    let posterUrl = null;
    const posterPath = path.join(VIDEOS_DIR, vidId, 'poster.jpg');
    if (fs.existsSync(posterPath)) {
      posterUrl = `${origin}/videos/${vidId}/poster.jpg`;
    } else if (settings.thumbnailUrl) {
      posterUrl = settings.thumbnailUrl;
    } else if (v.thumbnail) {
      posterUrl = v.thumbnail.startsWith('http') ? v.thumbnail : `${origin}${v.thumbnail}`;
    } else if (videoUrl) {
      posterUrl = `${videoUrl}#t=0.5`;
    }

    res.json({
      id: v.id,
      title: v.title,
      video_url: videoUrl,
      hls_url: hlsUrl,
      smartautoplay_url: smartautoplayUrl,
      poster_url: posterUrl,
      thumbnail: posterUrl,
      hls_ready: Boolean(v.hls_ready),
      duration: v.duration,
      settings,
      is_owner_preview: isOwnerPreview
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar vídeo.' });
  }
});

const ALLOWED_ANALYTICS_EVENTS = [
  'page_view',
  'play',
  'pause',
  'progress',
  'pitch_viewed',
  'cta_shown',
  'cta_clicked',
  'complete',
  'heartbeat'
];

app.post('/api/analytics/event', (req, res) => {
  try {
    const { videoId, visitorId, sessionId, eventType, milestone, watchTime } = req.body || {};

  if (!videoId || !visitorId || !sessionId || !eventType) {
    return res.status(400).json({ error: 'Dados analíticos insuficientes.' });
  }

  if (!ALLOWED_ANALYTICS_EVENTS.includes(eventType)) {
    return res.status(400).json({ error: 'Tipo de evento não reconhecido.' });
  }

  const cleanVidId = String(videoId).slice(0, 64);
  const cleanVisitorId = String(visitorId).slice(0, 64);
  const cleanSessionId = String(sessionId).slice(0, 64);
  const cleanMilestone = milestone !== undefined && milestone !== null ? parseInt(milestone, 10) : null;
  const cleanWatchTime = typeof watchTime === 'number' ? Math.max(0, watchTime) : 0;

  const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(cleanVidId);
  if (!video) {
    return res.status(404).json({ error: 'Vídeo não cadastrado.' });
  }

  if (eventType === 'heartbeat') {
    const lastHeartbeat = db.prepare(`
      SELECT id FROM analytics_events
      WHERE session_id = ? AND event_type = 'heartbeat'
      ORDER BY id DESC LIMIT 1
    `).get(cleanSessionId);
    if (lastHeartbeat) {
      db.prepare(`
        UPDATE analytics_events
        SET created_at = datetime('now'), watch_time = ?
        WHERE id = ?
      `).run(cleanWatchTime, lastHeartbeat.id);
      return res.json({ success: true, updated: true });
    }
  }

  if (eventType === 'progress' && cleanMilestone !== null) {
    const exists = db.prepare(`
      SELECT id FROM analytics_events
      WHERE session_id = ? AND event_type = 'progress' AND milestone = ?
      LIMIT 1
    `).get(cleanSessionId, cleanMilestone);
    if (exists) return res.json({ success: true, duplicate: true });
  }

  if (eventType === 'page_view') {
    const exists = db.prepare(`
      SELECT id FROM analytics_events
      WHERE session_id = ? AND event_type = 'page_view'
      LIMIT 1
    `).get(cleanSessionId);
    if (exists) return res.json({ success: true, duplicate: true });
  }

  if (eventType === 'pitch_viewed') {
    const exists = db.prepare(`
      SELECT id FROM analytics_events
      WHERE session_id = ? AND event_type = 'pitch_viewed'
      LIMIT 1
    `).get(cleanSessionId);
    if (exists) return res.json({ success: true, duplicate: true });
  }

  if (eventType === 'cta_shown') {
    const exists = db.prepare(`
      SELECT id FROM analytics_events
      WHERE session_id = ? AND event_type = 'cta_shown'
      LIMIT 1
    `).get(cleanSessionId);
    if (exists) return res.json({ success: true, duplicate: true });
  }

  const cleanDevice = req.body.device || 'desktop';
  const cleanBrowser = req.body.browser || 'Chrome';
  const cleanOs = req.body.os || 'Windows';
  const rawDomain = req.body.domain || (req.headers.referer ? (() => { try { return new URL(req.headers.referer).hostname; } catch(e){ return null; } })() : null);
  let cleanDomain = null;
  if (rawDomain && !rawDomain.startsWith('dash.') && !rawDomain.includes('localhost') && !rawDomain.includes('127.0.0.1')) {
    cleanDomain = rawDomain;
  }
  const cleanUtmSource = req.body.utm_source || null;
  const cleanUtmMedium = req.body.utm_medium || null;
  const cleanUtmCampaign = req.body.utm_campaign || null;
  const cleanUtmContent = req.body.utm_content || null;
  const cleanUtmTerm = req.body.utm_term || null;
  const cleanAmount = typeof req.body.conversion_amount === 'number' ? req.body.conversion_amount : 0;
  const cleanCurrency = req.body.conversion_currency || 'MT';
  const cleanPlatform = req.body.platform || null;

  const cfIp = req.headers['cf-connecting-ip'];
  const realIp = req.headers['x-real-ip'];
  const fwdFor = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const rawIp = (cfIp || realIp || fwdFor || req.ip || '').trim();
  const cleanIp = rawIp.replace(/^::ffff:/, '') || null;
  let geoCity = null;
  let geoRegion = null;
  let geoLat = null;
  let geoLng = null;
  let detectedCountry = null;

  const countryNameMap = {
    'MZ': 'Moçambique',
    'ZA': 'África do Sul',
    'BR': 'Brasil',
    'PT': 'Portugal',
    'AO': 'Angola',
    'CV': 'Cabo Verde',
    'GW': 'Guiné-Bissau',
    'ST': 'São Tomé e Príncipe',
    'US': 'Estados Unidos',
    'GB': 'Reino Unido',
    'ES': 'Espanha',
    'FR': 'França',
    'DE': 'Alemanha',
    'IT': 'Itália'
  };

  const cfCountry = (req.headers['cf-ipcountry'] || '').toUpperCase().trim();
  if (cfCountry && cfCountry !== 'XX' && cfCountry !== 'T1' && countryNameMap[cfCountry]) {
    detectedCountry = countryNameMap[cfCountry];
  }

  const clientTz = (req.body.timezone || '').trim();
  if (clientTz === 'Africa/Maputo') {
    detectedCountry = 'Moçambique';
  }

  if (cleanIp) {
    try {
      const geo = geoip.lookup(cleanIp);
      if (geo) {
        geoCity = geo.city || null;
        geoRegion = geo.region || null;
        if (!detectedCountry) {
          if (geo.country && countryNameMap[geo.country]) {
            detectedCountry = countryNameMap[geo.country];
          } else if (geo.country) {
            detectedCountry = geo.country;
          }
        }
        if (geo.ll && geo.ll.length === 2) {
          geoLat = geo.ll[0];
          geoLng = geo.ll[1];
        }
      }
    } catch (e) {}
  }

  let cleanCountry;
  if (detectedCountry) {
    cleanCountry = detectedCountry;
  } else if (req.body.country) {
    const rawCountry = req.body.country;
    cleanCountry = rawCountry === 'Mozambique' ? 'Moçambique' : (countryNameMap[rawCountry] || rawCountry);
  } else {
    cleanCountry = 'Moçambique';
  }

  if (cleanCountry === 'Moçambique') {
    if (!geoCity || geoCity.toLowerCase().includes('luanda') || geoCity.toLowerCase().includes('johannesburg')) {
      geoCity = 'Maputo';
      geoLat = -25.9692;
      geoLng = 32.5732;
    }
  } else if (geoCity && geoCity.toLowerCase().includes('johannesburg')) {
    cleanCountry = 'África do Sul';
    geoLat = -26.20;
    geoLng = 28.04;
  }

  const cleanUserAgent = (req.body.user_agent || req.headers['user-agent'] || '').slice(0, 512) || null;
  const cleanScreenWidth = Number.isInteger(req.body.screen_width) ? req.body.screen_width : null;
  const cleanScreenHeight = Number.isInteger(req.body.screen_height) ? req.body.screen_height : null;
  const cleanLanguage = req.body.language ? String(req.body.language).slice(0, 32) : null;
  const cleanTimezone = req.body.timezone ? String(req.body.timezone).slice(0, 64) : null;
  const cleanFbclid = req.body.fbclid ? String(req.body.fbclid).slice(0, 256) : null;
  const cleanTtclid = req.body.ttclid ? String(req.body.ttclid).slice(0, 256) : null;
  const cleanMetaEm = req.body.meta_em ? String(req.body.meta_em).slice(0, 128) : null;
  const cleanMetaPh = req.body.meta_ph ? String(req.body.meta_ph).slice(0, 128) : null;
  const cleanMetaFn = req.body.meta_fn ? String(req.body.meta_fn).slice(0, 128) : null;
  const cleanMetaLn = req.body.meta_ln ? String(req.body.meta_ln).slice(0, 128) : null;
  const cleanMetaExternalId = req.body.meta_external_id ? String(req.body.meta_external_id).slice(0, 256) : null;

  db.prepare(`
    INSERT INTO analytics_events (
      video_id, visitor_id, session_id, event_type, milestone, watch_time,
      device, browser, os, country, domain, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      conversion_amount, conversion_currency, platform,
      ip_address, city, region, latitude, longitude,
      user_agent, screen_width, screen_height, language, timezone,
      fbclid, ttclid, meta_em, meta_ph, meta_fn, meta_ln, meta_external_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cleanVidId, cleanVisitorId, cleanSessionId, eventType, cleanMilestone, cleanWatchTime,
    cleanDevice, cleanBrowser, cleanOs, cleanCountry, cleanDomain, cleanUtmSource, cleanUtmMedium, cleanUtmCampaign, cleanUtmContent, cleanUtmTerm,
    cleanAmount, cleanCurrency, cleanPlatform,
    cleanIp, geoCity, geoRegion, geoLat, geoLng,
    cleanUserAgent, cleanScreenWidth, cleanScreenHeight, cleanLanguage, cleanTimezone,
    cleanFbclid, cleanTtclid, cleanMetaEm, cleanMetaPh, cleanMetaFn, cleanMetaLn, cleanMetaExternalId
  );

  if (eventType === 'play') {
    db.prepare(`
      UPDATE videos
      SET plays = (
        SELECT COUNT(*)
        FROM analytics_events
        WHERE video_id = ? AND event_type = 'play'
      )
      WHERE id = ?
    `).run(cleanVidId, cleanVidId);
  }

    res.json({ success: true });
  } catch (err) {
    console.error('[ANALYTICS_EVENT_ERROR]:', err);
    res.status(500).json({ error: 'Erro ao processar evento analítico.' });
  }
});

app.get('/api/analytics/overview', authMiddleware, (req, res) => {
  const videoFilter = 'video_id IN (SELECT id FROM videos WHERE user_id = ' + req.user.id + ' AND deleted_at IS NULL)';

  const userVideos = db.prepare('SELECT id, title, plays FROM videos WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(req.user.id);

  const totalViews = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'page_view' AND ${videoFilter}`).get().count;
  const totalPlays = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'play' AND ${videoFilter}`).get().count;
  const uniquePlays = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as count FROM analytics_events WHERE event_type = 'play' AND ${videoFilter}`).get().count;
  const ctaClicks = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'cta_clicked' AND ${videoFilter}`).get().count;
  const pitchViews = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'pitch_viewed' AND ${videoFilter}`).get().count;
  const completes = db.prepare(`SELECT COUNT(DISTINCT session_id) as count FROM analytics_events WHERE (event_type = 'complete' OR (event_type = 'progress' AND milestone = 100)) AND ${videoFilter}`).get().count;

  const completionRate = totalPlays > 0 ? ((completes / totalPlays) * 100).toFixed(1) : '0.0';
  const conversionRate = totalPlays > 0 ? ((ctaClicks / totalPlays) * 100).toFixed(1) : '0.0';

  const isOwner = req.user.role === 'owner';
  const usedBytes = isOwner ? getUsedStorageBytes() : getUserStorageBytes(req.user.id);
  const totalBytes = isOwner ? SERVER_STORAGE_LIMIT_BYTES : MEMBER_STORAGE_LIMIT_BYTES;

  res.json({
    totalViews,
    totalPlays,
    uniquePlays,
    ctaClicks,
    pitchViews,
    completionRate,
    conversionRate,
    usedStorage: {
      usedBytes,
      totalBytes,
      formatted: formatStorage(usedBytes),
      isIndividual: !isOwner
    }
  });
});

app.get('/api/analytics/video/:id', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const video = db.prepare('SELECT id, title, user_id, plays, duration, settings_json, video_url, file_path, hls_ready, hls_manifest FROM videos WHERE id = ?').get(vidId);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && video.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  if (!video.hls_ready) {
    const videoDir = path.join(VIDEOS_DIR, vidId);
    const masterPlaylist = path.join(videoDir, 'main.m3u8');
    if (fs.existsSync(masterPlaylist)) {
      const manifestUrl = `/videos/${vidId}/main.m3u8`;
      try {
        db.prepare('UPDATE videos SET hls_ready = 1, hls_manifest = ? WHERE id = ?').run(manifestUrl, vidId);
        video.hls_ready = 1;
        video.hls_manifest = manifestUrl;
      } catch (e) {}
    } else {
      processVideoHLS(vidId);
    }
  }

  const period = req.query.period || 'today';
  const startDate = req.query.startDate;
  const endDate = req.query.endDate;

  let dateCondition = "date(created_at, '+2 hours') = date('now', '+2 hours')";
  let prevCondition = "date(created_at, '+2 hours') = date('now', '+2 hours', '-1 day')";

  if (period === 'today') {
    dateCondition = "date(created_at, '+2 hours') = date('now', '+2 hours')";
    prevCondition = "date(created_at, '+2 hours') = date('now', '+2 hours', '-1 day')";
  } else if (period === 'yesterday') {
    dateCondition = "date(created_at, '+2 hours') = date('now', '+2 hours', '-1 day')";
    prevCondition = "date(created_at, '+2 hours') = date('now', '+2 hours', '-2 days')";
  } else if (period === '7d') {
    dateCondition = "created_at >= datetime('now', '-7 days')";
    prevCondition = "created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')";
  } else if (period === '30d') {
    dateCondition = "created_at >= datetime('now', '-30 days')";
    prevCondition = "created_at >= datetime('now', '-60 days') AND created_at < datetime('now', '-30 days')";
  } else if (period === 'month') {
    dateCondition = "strftime('%Y-%m', created_at, '+2 hours') = strftime('%Y-%m', 'now', '+2 hours')";
    prevCondition = "strftime('%Y-%m', created_at, '+2 hours') = strftime('%Y-%m', 'now', '+2 hours', 'start of month', '-1 month')";
  } else if (period === 'all') {
    dateCondition = "1=1";
    prevCondition = "0=1";
  } else if (period === 'custom' && startDate && endDate) {
    const sDate = String(startDate).slice(0, 10);
    const eDate = String(endDate).slice(0, 10);
    dateCondition = `date(created_at, '+2 hours') >= date('${sDate}') AND date(created_at, '+2 hours') <= date('${eDate}')`;
    const sTime = new Date(sDate).getTime();
    const eTime = new Date(eDate).getTime();
    const diffDays = Math.max(1, Math.round(Math.abs((eTime - sTime) / (1000 * 60 * 60 * 24)))) + 1;
    prevCondition = `date(created_at, '+2 hours') >= date('${sDate}', '-${diffDays} days') AND date(created_at, '+2 hours') < date('${sDate}')`;
  }

  function calcDiff(curr, prev) {
    const c = Number(curr) || 0;
    const p = Number(prev) || 0;
    if (p === 0) {
      return {
        text: c > 0 ? '+100%' : '0%',
        isPositive: c >= 0,
        neutral: c === 0
      };
    }
    const diff = ((c - p) / p) * 100;
    const rounded = Math.abs(diff) < 0.1 ? '0%' : (diff > 0 ? `+${diff.toFixed(1)}%` : `${diff.toFixed(1)}%`);
    return {
      text: rounded,
      isPositive: diff >= 0,
      neutral: diff === 0
    };
  }

  const views = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'page_view' AND ${dateCondition}`).get(vidId).count;
  const prevViews = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'page_view' AND ${prevCondition}`).get(vidId).count;

  const uniqueVisitors = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as count FROM analytics_events WHERE video_id = ? AND ${dateCondition}`).get(vidId).count;
  const prevUniqueVisitors = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as count FROM analytics_events WHERE video_id = ? AND ${prevCondition}`).get(vidId).count;

  const plays = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${dateCondition}`).get(vidId).count;
  const prevPlays = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${prevCondition}`).get(vidId).count;

  const basePlays = plays;
  const baseViews = views;

  const playRate = baseViews > 0 ? ((basePlays / baseViews) * 100).toFixed(1) : '0.0';
  const prevPlayRate = prevViews > 0 ? ((prevPlays / prevViews) * 100).toFixed(1) : '0.0';

  const pitchViews = db.prepare(`SELECT COUNT(DISTINCT session_id) as count FROM analytics_events WHERE video_id = ? AND event_type = 'pitch_viewed' AND ${dateCondition}`).get(vidId).count;
  const ctaShown = db.prepare(`SELECT COUNT(DISTINCT session_id) as count FROM analytics_events WHERE video_id = ? AND event_type = 'cta_shown' AND ${dateCondition}`).get(vidId).count;
  const ctaClicks = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'cta_clicked' AND ${dateCondition}`).get(vidId).count;
  const ctaUniqueClicks = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as count FROM analytics_events WHERE video_id = ? AND event_type = 'cta_clicked' AND ${dateCondition}`).get(vidId).count;
  const ctaClickRate = basePlays > 0 ? ((ctaClicks / basePlays) * 100).toFixed(1) : (baseViews > 0 ? ((ctaClicks / baseViews) * 100).toFixed(1) : '0.0');

  const conversions = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type IN ('conversion', 'sale', 'purchase', 'lead') AND ${dateCondition}`).get(vidId).count;
  const prevConversions = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type IN ('conversion', 'sale', 'purchase', 'lead') AND ${prevCondition}`).get(vidId).count;
  const conversionRate = baseViews > 0 ? ((conversions / baseViews) * 100).toFixed(2) : '0.00';

  const revRow = db.prepare(`SELECT COALESCE(SUM(conversion_amount), 0) as total FROM analytics_events WHERE video_id = ? AND event_type IN ('conversion', 'sale', 'purchase') AND ${dateCondition}`).get(vidId);
  const revenue = revRow ? Number(revRow.total || 0) : 0;
  const prevRevRow = db.prepare(`SELECT COALESCE(SUM(conversion_amount), 0) as total FROM analytics_events WHERE video_id = ? AND event_type IN ('conversion', 'sale', 'purchase') AND ${prevCondition}`).get(vidId);
  const prevRevenue = prevRevRow ? Number(prevRevRow.total || 0) : 0;

  const milestonesList = [10, 25, 50, 75, 90, 100];
  const retentionCurve = [];

  retentionCurve.push({
    milestone: 0,
    label: '0%',
    sessions: basePlays,
    percent: basePlays > 0 ? 100 : 0
  });

  for (const m of milestonesList) {
    const count = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as count
      FROM analytics_events
      WHERE video_id = ? AND event_type = 'progress' AND milestone = ? AND ${dateCondition}
    `).get(vidId, m).count;

    const pct = basePlays > 0 ? Math.min(100, Math.round((count / basePlays) * 100)) : 0;
    retentionCurve.push({
      milestone: m,
      label: `${m}%`,
      sessions: count,
      percent: pct
    });
  }

  const audienceTimeline = [
    { label: 'Início', viewers: basePlays, pct: basePlays > 0 ? 100 : 0 },
    { label: '1 min', viewers: Math.round(basePlays * 0.82), pct: 82 },
    { label: 'Pitch', viewers: pitchViews || Math.round(basePlays * 0.54), pct: basePlays > 0 ? Math.round((pitchViews / basePlays) * 100) : 54 },
    { label: 'CTA', viewers: ctaShown || Math.round(basePlays * 0.46), pct: basePlays > 0 ? Math.round((ctaShown / basePlays) * 100) : 46 },
    { label: 'Fim', viewers: (retentionCurve.find(x => x.milestone === 100) || {}).sessions || Math.round(basePlays * 0.28), pct: (retentionCurve.find(x => x.milestone === 100) || {}).percent || 28 }
  ];

  let videoSettings = {};
  try {
    if (video.settings_json) videoSettings = JSON.parse(video.settings_json);
  } catch (e) {}

  const actionButtons = [];
  if (Boolean(videoSettings.ctaEnabled && videoSettings.ctaUrl && videoSettings.ctaUrl.trim() && videoSettings.ctaUrl !== 'https://seusite.com/checkout')) {
    const ctaSec = Number(videoSettings.ctaTime || 0);
    const m = Math.floor(ctaSec / 60).toString().padStart(2, '0');
    const s = (ctaSec % 60).toString().padStart(2, '0');
    actionButtons.push({
      id: 'cta_primary',
      title: videoSettings.ctaText || 'Botão de Ação',
      timeFormatted: `${m}:${s}`,
      timeSeconds: ctaSec,
      url: videoSettings.ctaUrl || '',
      clicks: ctaClicks,
      views: ctaShown > 0 ? ctaShown : pitchViews,
      ctr: ctaClickRate,
      color: videoSettings.ctaColor || '#16A34A',
      subtext: videoSettings.ctaSubtext || ''
    });
  }

  res.json({
    video: {
      id: video.id,
      title: video.title
    },
    period,
    metrics: {
      views: baseViews,
      prevViews,
      viewsDiff: calcDiff(baseViews, prevViews),

      uniqueVisitors,
      prevUniqueVisitors,
      uniqueVisitorsDiff: calcDiff(uniqueVisitors, prevUniqueVisitors),

      plays: basePlays,
      playRate,
      prevPlayRate,
      playRateDiff: calcDiff(playRate, prevPlayRate),

      ctaClicks,
      ctaClickRate,
      ctaShown,
      ctaUniqueClicks,

      conversions,
      prevConversions,
      conversionRate,
      conversionsDiff: calcDiff(conversions, prevConversions),

      revenue,
      prevRevenue,
      revenueFormatted: `${revenue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MT`,
      revenueDiff: calcDiff(revenue, prevRevenue),

      pitchViews,
      pitchRate: basePlays > 0 ? ((pitchViews / basePlays) * 100).toFixed(1) : '0.0'
    },
    video_url: video.video_url,
    hls_ready: Boolean(video.hls_ready),
    hls_manifest: video.hls_manifest,
    retentionCurve,
    audienceTimeline,
    actionButtons
  });
});

function buildDateCondition(period, startDate, endDate) {
  if (period === 'today') {
    return { dc: "date(created_at, '+2 hours') = date('now', '+2 hours')" };
  } else if (period === 'yesterday') {
    return { dc: "date(created_at, '+2 hours') = date('now', '+2 hours', '-1 day')" };
  } else if (period === '7d') {
    return { dc: "created_at >= datetime('now', '-7 days')" };
  } else if (period === '30d') {
    return { dc: "created_at >= datetime('now', '-30 days')" };
  } else if (period === 'month') {
    return { dc: "strftime('%Y-%m', created_at, '+2 hours') = strftime('%Y-%m', 'now', '+2 hours')" };
  } else if (period === 'all') {
    return { dc: '1=1' };
  } else if (period === 'custom' && startDate && endDate) {
    const sDate = String(startDate).slice(0, 10);
    const eDate = String(endDate).slice(0, 10);
    return { dc: `date(created_at, '+2 hours') >= date('${sDate}') AND date(created_at, '+2 hours') <= date('${eDate}')` };
  }
  return { dc: "date(created_at, '+2 hours') = date('now', '+2 hours')" };
}

app.get('/api/analytics/video/:id/retention', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const video = db.prepare('SELECT id, user_id, plays, duration, settings_json FROM videos WHERE id = ? AND deleted_at IS NULL').get(vidId);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && video.user_id !== req.user.id) return res.status(403).json({ error: 'Permissão negada.' });

  const { dc } = buildDateCondition(req.query.period || 'today', req.query.startDate, req.query.endDate);
  const filterType = (req.query.filterType || '').toLowerCase();
  const filterValue = req.query.filterValue || '';
  const trafficParam = (req.query.trafficParam || 'utm_source').toLowerCase();
  const search = (req.query.search || '').trim();

  let durSec = 60;
  if (video.duration) {
    const parts = String(video.duration).split(':').map(Number);
    if (parts.length === 2) durSec = (parts[0] * 60) + parts[1];
    else if (parts.length === 3) durSec = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    else durSec = Number(video.duration) || 60;
  }
  let pitchSec = 30;
  try {
    if (video.settings_json) {
      const vs = JSON.parse(video.settings_json);
      if (vs.pitchTime) pitchSec = Number(vs.pitchTime);
      else if (vs.ctaTime) pitchSec = Number(vs.ctaTime);
    }
  } catch (e) {}
  const pitchPct = durSec > 0 ? Math.min(100, Math.max(0, Math.round((pitchSec / durSec) * 100))) : 50;

  let segFilterClause = '1=1';
  const segParams = [vidId];
  if (filterType && filterValue) {
    if (filterType === 'country' || filterType === 'countries') {
      segFilterClause = "COALESCE(country, 'Desconhecido') = ?";
      segParams.push(filterValue);
    } else if (filterType === 'device' || filterType === 'devices') {
      segFilterClause = "COALESCE(device, 'desktop') = ?";
      segParams.push(filterValue);
    } else if (filterType === 'os') {
      segFilterClause = "COALESCE(os, 'Other') = ?";
      segParams.push(filterValue);
    } else if (filterType === 'browser' || filterType === 'browsers') {
      segFilterClause = "COALESCE(browser, 'Other') = ?";
      segParams.push(filterValue);
    } else if (filterType === 'traffic') {
      const allowedCols = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'domain'];
      const tCol = allowedCols.includes(trafficParam) ? trafficParam : 'utm_source';
      segFilterClause = `COALESCE(${tCol}, 'Direto') = ?`;
      segParams.push(filterValue);
    }
  }

  const totalPlays = db.prepare(`SELECT COUNT(*) as c FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${dc} AND ${segFilterClause}`).get(...segParams).c;

  const milestones = [0, 10, 25, 50, 75, 90, 100];
  const retentionCurve = milestones.map(m => {
    let count;
    if (m === 0) {
      count = totalPlays;
    } else {
      count = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_events WHERE video_id = ? AND event_type = 'progress' AND milestone = ? AND ${dc} AND ${segFilterClause}`).get(...segParams, m).c;
    }
    return {
      milestone: m,
      label: `${m}%`,
      sessions: count,
      percent: totalPlays > 0 ? Math.min(100, Math.round((count / totalPlays) * 100)) : 0
    };
  });

  function queryDimensionRows(dimExpr, extraWhere = '') {
    const q = `
      SELECT
        ${dimExpr} as name,
        COUNT(CASE WHEN event_type = 'page_view' THEN 1 END) as views,
        COUNT(DISTINCT CASE WHEN event_type = 'page_view' THEN visitor_id END) as unique_views,
        COUNT(CASE WHEN event_type = 'play' THEN 1 END) as plays,
        COUNT(DISTINCT CASE WHEN event_type = 'play' THEN visitor_id END) as unique_plays,
        COUNT(CASE WHEN event_type = 'cta_clicked' THEN 1 END) as cta_clicks,
        COUNT(CASE WHEN conversion_amount > 0 OR event_type IN ('conversion', 'sale', 'purchase', 'lead') THEN 1 END) as conversions,
        COALESCE(SUM(CASE WHEN conversion_amount > 0 THEN conversion_amount ELSE 0 END), 0) as revenue,
        COALESCE(AVG(CASE WHEN event_type = 'progress' AND milestone IS NOT NULL THEN milestone END), 0) as avg_milestone,
        COUNT(DISTINCT CASE WHEN event_type = 'pitch_viewed' OR (event_type = 'progress' AND milestone >= ${pitchPct}) THEN session_id END) as pitch_audience
      FROM analytics_events
      WHERE video_id = ? AND ${dc} ${extraWhere}
      GROUP BY name
      HAVING (views > 0 OR plays > 0)
      ORDER BY plays DESC, views DESC
      LIMIT 100
    `;
    const rows = db.prepare(q).all(vidId);
    return rows.map(r => {
      const views = Number(r.views || 0);
      const uViews = Number(r.unique_views || 0);
      const plays = Number(r.plays || 0);
      const uPlays = Number(r.unique_plays || 0);
      const cta = Number(r.cta_clicks || 0);
      const conv = Number(r.conversions || 0);
      const rev = Number(Number(r.revenue || 0).toFixed(2));
      const pitchAud = Number(r.pitch_audience || 0);
      const playRate = uViews > 0 ? Math.min(100, Number(((uPlays / uViews) * 100).toFixed(2))) : 0;
      const eng = Math.min(100, Math.round(Number(r.avg_milestone || 0)));
      const pitchRet = uPlays > 0 ? Math.min(100, Number(((pitchAud / uPlays) * 100).toFixed(2))) : 0;
      const convRate = uPlays > 0 ? Math.min(100, Number(((conv / uPlays) * 100).toFixed(2))) : 0;
      return {
        name: r.name || 'Desconhecido',
        views,
        unique_views: uViews,
        plays,
        unique_plays: uPlays,
        play_rate: playRate,
        engagement: eng,
        pitch_retention: pitchRet,
        pitch_audience: pitchAud,
        cta_clicks: cta,
        conversions: conv,
        conversion_rate: convRate,
        revenue: rev,
        revenue_formatted: `${rev.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MT`
      };
    });
  }

  const countries = queryDimensionRows("COALESCE(country, 'Desconhecido')");
  const devices = queryDimensionRows("COALESCE(device, 'desktop')");
  const osList = queryDimensionRows("COALESCE(os, 'Other')");
  const browsers = queryDimensionRows("COALESCE(browser, 'Other')");

  const allowedTrafficCols = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'domain'];
  const activeTrafficCol = allowedTrafficCols.includes(trafficParam) ? trafficParam : 'utm_source';
  let trafficSearchClause = '';
  if (search) {
    const escaped = search.replace(/'/g, "''");
    trafficSearchClause = `AND (COALESCE(${activeTrafficCol}, 'Direto') LIKE '%${escaped}%')`;
  }

  const trafficExpr = activeTrafficCol === 'domain'
    ? `CASE
        WHEN domain IS NOT NULL AND domain != '' AND domain NOT LIKE 'dash.%' AND domain NOT LIKE '%roleta-sorte.online'
        THEN domain
        ELSE 'Direto'
      END`
    : `COALESCE(NULLIF(${activeTrafficCol}, ''), 'Direto')`;

  const traffic = queryDimensionRows(trafficExpr, trafficSearchClause);

  res.json({
    totalPlays,
    retentionCurve,
    countries,
    devices,
    os: osList,
    browsers,
    traffic,
    trafficParam: activeTrafficCol,
    pitchPct,
    pitchSec
  });
});

app.get('/api/analytics/video/:id/summary', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const video = db.prepare('SELECT id, user_id FROM videos WHERE id = ? AND deleted_at IS NULL').get(vidId);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && video.user_id !== req.user.id) return res.status(403).json({ error: 'Permissão negada.' });

  const period = req.query.period || 'today';
  const { dc } = buildDateCondition(period, req.query.startDate, req.query.endDate);

  let groupFmt = "date(created_at, '+2 hours')";
  let labelFmt = groupFmt;
  if (period === 'today' || period === 'yesterday') {
    groupFmt = "strftime('%H', created_at, '+2 hours')";
    labelFmt = groupFmt;
  }

  const viewsRows = db.prepare(`SELECT ${labelFmt} as label, COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'page_view' AND ${dc} GROUP BY label ORDER BY label`).all(vidId);
  const uViewsRows = db.prepare(`SELECT ${labelFmt} as label, COUNT(DISTINCT visitor_id) as count FROM analytics_events WHERE video_id = ? AND event_type = 'page_view' AND ${dc} GROUP BY label ORDER BY label`).all(vidId);
  const playsRows = db.prepare(`SELECT ${labelFmt} as label, COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${dc} GROUP BY label ORDER BY label`).all(vidId);
  const uPlaysRows = db.prepare(`SELECT ${labelFmt} as label, COUNT(DISTINCT visitor_id) as count FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${dc} GROUP BY label ORDER BY label`).all(vidId);
  const ctaRows = db.prepare(`SELECT ${labelFmt} as label, COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'cta_clicked' AND ${dc} GROUP BY label ORDER BY label`).all(vidId);
  const convRows = db.prepare(`SELECT ${labelFmt} as label, COUNT(*) as count FROM analytics_events WHERE video_id = ? AND (conversion_amount > 0 OR event_type IN ('conversion', 'sale', 'purchase', 'lead')) AND ${dc} GROUP BY label ORDER BY label`).all(vidId);
  const revRows = db.prepare(`SELECT ${labelFmt} as label, COALESCE(SUM(conversion_amount), 0) as count FROM analytics_events WHERE video_id = ? AND ${dc} GROUP BY label ORDER BY label`).all(vidId);
  const engRows = db.prepare(`SELECT ${labelFmt} as label, AVG(milestone) as count FROM analytics_events WHERE video_id = ? AND event_type = 'progress' AND milestone IS NOT NULL AND ${dc} GROUP BY label ORDER BY label`).all(vidId);

  const toMap = rows => Object.fromEntries(rows.map(r => [r.label, Number(r.count || 0)]));
  const viewsMap = toMap(viewsRows);
  const uViewsMap = toMap(uViewsRows);
  const playsMap = toMap(playsRows);
  const uPlaysMap = toMap(uPlaysRows);
  const ctaMap = toMap(ctaRows);
  const convMap = toMap(convRows);
  const revMap = toMap(revRows);
  const engMap = toMap(engRows);

  let labels = [];
  if (period === 'today' || period === 'yesterday') {
    for (let h = 0; h < 24; h++) {
      labels.push(String(h).padStart(2, '0'));
    }
  } else if (period === '7d' || period === '30d') {
    const days = period === '7d' ? 7 : 30;
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      labels.push(d.toISOString().slice(0, 10));
    }
  } else {
    const allLabels = [...new Set([
      ...viewsRows, ...uViewsRows, ...playsRows, ...uPlaysRows, ...ctaRows, ...convRows, ...revRows, ...engRows
    ].map(r => r.label))].sort();
    labels = allLabels.length > 0 ? allLabels : [new Date().toISOString().slice(0, 10)];
  }

  const series = {
    views: labels.map(l => viewsMap[l] || 0),
    unique_views: labels.map(l => uViewsMap[l] || 0),
    plays: labels.map(l => playsMap[l] || 0),
    unique_plays: labels.map(l => uPlaysMap[l] || 0),
    play_rate: labels.map(l => {
      const uv = uViewsMap[l] || 0;
      const up = uPlaysMap[l] || 0;
      return uv > 0 ? Math.min(100, Number(((up / uv) * 100).toFixed(1))) : 0;
    }),
    engagement: labels.map(l => Math.min(100, Math.round(engMap[l] || 0))),
    cta_clicks: labels.map(l => ctaMap[l] || 0),
    conversions: labels.map(l => convMap[l] || 0),
    conversion_rate: labels.map(l => {
      const up = uPlaysMap[l] || 0;
      const cv = convMap[l] || 0;
      return up > 0 ? Math.min(100, Number(((cv / up) * 100).toFixed(1))) : 0;
    }),
    revenue: labels.map(l => Number(Number(revMap[l] || 0).toFixed(2)))
  };

  const totalViews = series.views.reduce((a, b) => a + b, 0);
  const totalUViews = series.unique_views.reduce((a, b) => a + b, 0);
  const totalPlays = series.plays.reduce((a, b) => a + b, 0);
  const totalUPlays = series.unique_plays.reduce((a, b) => a + b, 0);
  const totalCta = series.cta_clicks.reduce((a, b) => a + b, 0);
  const totalConv = series.conversions.reduce((a, b) => a + b, 0);
  const totalRev = Number(series.revenue.reduce((a, b) => a + b, 0).toFixed(2));
  const overallPlayRate = totalUViews > 0 ? Math.min(100, Number(((totalUPlays / totalUViews) * 100).toFixed(1))) : 0;
  const overallConvRate = totalUPlays > 0 ? Math.min(100, Number(((totalConv / totalUPlays) * 100).toFixed(1))) : 0;
  const engValues = series.engagement.filter(v => v > 0);
  const overallEngagement = engValues.length > 0 ? Math.round(engValues.reduce((a, b) => a + b, 0) / engValues.length) : 0;

  const totals = {
    views: totalViews,
    unique_views: totalUViews,
    plays: totalPlays,
    unique_plays: totalUPlays,
    play_rate: overallPlayRate,
    engagement: overallEngagement,
    cta_clicks: totalCta,
    conversions: totalConv,
    conversion_rate: overallConvRate,
    revenue: totalRev
  };

  res.json({ labels, series, totals, period });
});

app.get('/api/analytics/video/:id/funnel', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const video = db.prepare('SELECT id, user_id FROM videos WHERE id = ? AND deleted_at IS NULL').get(vidId);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && video.user_id !== req.user.id) return res.status(403).json({ error: 'Permissão negada.' });

  const { dc } = buildDateCondition(req.query.period || 'today', req.query.startDate, req.query.endDate);

  const uniqueViews = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as c FROM analytics_events WHERE video_id = ? AND event_type = 'page_view' AND ${dc}`).get(vidId).c;
  const uniquePlays = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as c FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${dc}`).get(vidId).c;
  const uniqueCtaClicks = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as c FROM analytics_events WHERE video_id = ? AND event_type = 'cta_clicked' AND ${dc}`).get(vidId).c;
  const conversions = db.prepare(`SELECT COUNT(*) as c FROM analytics_events WHERE video_id = ? AND conversion_amount > 0 AND ${dc}`).get(vidId).c;

  const w10 = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_events WHERE video_id = ? AND event_type = 'progress' AND milestone = 10 AND ${dc}`).get(vidId).c;
  const w25 = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_events WHERE video_id = ? AND event_type = 'progress' AND milestone = 25 AND ${dc}`).get(vidId).c;
  const w50 = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_events WHERE video_id = ? AND event_type = 'progress' AND milestone = 50 AND ${dc}`).get(vidId).c;
  const w75 = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_events WHERE video_id = ? AND event_type = 'progress' AND milestone = 75 AND ${dc}`).get(vidId).c;
  const w100 = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_events WHERE video_id = ? AND event_type = 'progress' AND milestone = 100 AND ${dc}`).get(vidId).c;

  const stages = {
    views: { key: 'views', label: 'Visualizações Únicas', count: uniqueViews },
    plays: { key: 'plays', label: 'Plays Únicos', count: uniquePlays },
    cta: { key: 'cta', label: 'Cliques no Botão', count: uniqueCtaClicks },
    conversions: { key: 'conversions', label: 'Conversões', count: conversions },
    watch_10: { key: 'watch_10', label: 'Assistiu 10%', count: w10 },
    watch_25: { key: 'watch_25', label: 'Assistiu 25%', count: w25 },
    watch_50: { key: 'watch_50', label: 'Assistiu 50%', count: w50 },
    watch_75: { key: 'watch_75', label: 'Assistiu 75%', count: w75 },
    watch_100: { key: 'watch_100', label: 'Assistiu 100%', count: w100 }
  };

  res.json({ stages });
});

app.get('/api/analytics/video/:id/benchmark', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const video = db.prepare('SELECT id, user_id FROM videos WHERE id = ? AND deleted_at IS NULL').get(vidId);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && video.user_id !== req.user.id) return res.status(403).json({ error: 'Permissão negada.' });

  const { dc } = buildDateCondition(req.query.period || 'all', req.query.startDate, req.query.endDate);
  const uniquePlays = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as c FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${dc}`).get(vidId).c;
  const required = 200;

  res.json({ hasEnoughData: uniquePlays >= required, uniquePlays, required });
});

app.get('/api/analytics/video/:id/best-times', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const video = db.prepare('SELECT id, user_id FROM videos WHERE id = ? AND deleted_at IS NULL').get(vidId);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && video.user_id !== req.user.id) return res.status(403).json({ error: 'Permissão negada.' });

  const { dc } = buildDateCondition(req.query.period || '30d', req.query.startDate, req.query.endDate);
  const metric = (req.query.metric || 'cta').toLowerCase();

  let eventFilter = "event_type = 'cta_clicked'";
  let countExpr = "COUNT(*) as count";

  if (metric === 'views') {
    eventFilter = "event_type = 'page_view'";
    countExpr = "COUNT(*) as count";
  } else if (metric === 'unique_views') {
    eventFilter = "event_type = 'page_view'";
    countExpr = "COUNT(DISTINCT visitor_id) as count";
  } else if (metric === 'plays') {
    eventFilter = "event_type = 'play'";
    countExpr = "COUNT(*) as count";
  } else if (metric === 'unique_plays') {
    eventFilter = "event_type = 'play'";
    countExpr = "COUNT(DISTINCT visitor_id) as count";
  } else if (metric === 'cta') {
    eventFilter = "event_type = 'cta_clicked'";
    countExpr = "COUNT(DISTINCT visitor_id) as count";
  } else if (metric === 'conversions') {
    eventFilter = "conversion_amount > 0";
    countExpr = "COUNT(*) as count";
  } else if (metric === 'revenue') {
    eventFilter = "conversion_amount > 0";
    countExpr = "COALESCE(SUM(conversion_amount), 0) as count";
  } else if (metric === 'play_rate') {
    eventFilter = "event_type IN ('play', 'page_view')";
    countExpr = "ROUND(CAST(SUM(CASE WHEN event_type = 'play' THEN 1 ELSE 0 END) AS FLOAT) / MAX(1, SUM(CASE WHEN event_type = 'page_view' THEN 1 ELSE 0 END)) * 100, 1) as count";
  } else if (metric === 'engagement') {
    eventFilter = "event_type = 'progress'";
    countExpr = "COUNT(DISTINCT session_id) as count";
  } else if (metric === 'conversion_rate') {
    eventFilter = "event_type IN ('play', 'conversion')";
    countExpr = "ROUND(CAST(SUM(CASE WHEN conversion_amount > 0 THEN 1 ELSE 0 END) AS FLOAT) / MAX(1, SUM(CASE WHEN event_type = 'play' THEN 1 ELSE 0 END)) * 100, 1) as count";
  } else if (metric === 'rpv') {
    eventFilter = "event_type IN ('play', 'conversion')";
    countExpr = "ROUND(COALESCE(SUM(conversion_amount), 0) / MAX(1, SUM(CASE WHEN event_type = 'play' THEN 1 ELSE 0 END)), 2) as count";
  }

  const rows = db.prepare(`
    SELECT
      CAST(strftime('%H', created_at, '+2 hours') AS INTEGER) as hour_num,
      CAST(strftime('%w', created_at, '+2 hours') AS INTEGER) as weekday,
      ${countExpr}
    FROM analytics_events
    WHERE video_id = ? AND ${eventFilter} AND ${dc}
    GROUP BY hour_num, weekday
    ORDER BY weekday, hour_num
  `).all(vidId);

  const heatmap = [];
  const hourBands = ['00h-02h','02h-04h','04h-06h','06h-08h','08h-10h','10h-12h','12h-14h','14h-16h','16h-18h','18h-20h','20h-22h','22h-24h'];
  for (let w = 0; w < 7; w++) {
    for (let b = 0; b < 12; b++) {
      const startH = b * 2;
      const endH = startH + 2;
      const matching = rows.filter(r => r.weekday === w && r.hour_num >= startH && r.hour_num < endH);
      const count = matching.reduce((s, r) => s + (Number(r.count) || 0), 0);
      heatmap.push({ weekday: w, hour_band: hourBands[b], count });
    }
  }

  const maxCount = Math.max(1, ...heatmap.map(h => h.count));
  heatmap.forEach(h => {
    const ratio = h.count / maxCount;
    h.level = ratio === 0 ? 'zero' : ratio < 0.25 ? 'low' : ratio < 0.55 ? 'medium' : ratio < 0.85 ? 'high' : 'peak';
  });

  res.json({
    metric,
    heatmap,
    hourBands,
    weekdays: ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']
  });
});

app.get('/api/analytics/video/:id/live', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const video = db.prepare('SELECT id, user_id FROM videos WHERE id = ? AND deleted_at IS NULL').get(vidId);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && video.user_id !== req.user.id) return res.status(403).json({ error: 'Permissão negada.' });

  const activeRows = db.prepare(`
    SELECT COUNT(DISTINCT visitor_id) as c
    FROM analytics_events
    WHERE video_id = ? AND created_at >= datetime('now', '-3 minutes')
      AND visitor_id NOT LIKE 'test_vis%'
  `).get(vidId);

  const countryLocations = {
    'Mozambique': { lat: -18.66, lon: 35.52, code: 'MZ' },
    'Moçambique': { lat: -18.66, lon: 35.52, code: 'MZ' },
    'South Africa': { lat: -26.20, lon: 28.04, code: 'ZA' },
    'África do Sul': { lat: -26.20, lon: 28.04, code: 'ZA' },
    'Brazil': { lat: -14.23, lon: -51.92, code: 'BR' },
    'Brasil': { lat: -14.23, lon: -51.92, code: 'BR' },
    'Portugal': { lat: 39.39, lon: -8.22, code: 'PT' },
    'Angola': { lat: -11.20, lon: 17.87, code: 'AO' },
    'United States': { lat: 37.09, lon: -95.71, code: 'US' },
    'Estados Unidos': { lat: 37.09, lon: -95.71, code: 'US' },
    'Spain': { lat: 40.46, lon: -3.74, code: 'ES' },
    'Espanha': { lat: 40.46, lon: -3.74, code: 'ES' }
  };

  const activeViewers = db.prepare(`
    SELECT country, city, timezone, COUNT(DISTINCT visitor_id) as viewers
    FROM analytics_events
    WHERE video_id = ? AND created_at >= datetime('now', '-3 minutes')
      AND visitor_id NOT LIKE 'test_vis%'
    GROUP BY country, city, timezone
  `).all(vidId).map(v => {
    let cName = v.country || 'Moçambique';
    let city = v.city || '';
    let lat = null;
    let lon = null;
    if (v.timezone === 'Africa/Maputo' || cName === 'Moçambique' || (city && city.toLowerCase().includes('luanda') && cName === 'Angola')) {
      cName = 'Moçambique';
      city = (!city || city.toLowerCase().includes('luanda') || city.toLowerCase().includes('johannesburg')) ? 'Maputo' : city;
      lat = -25.9692;
      lon = 32.5732;
    } else if (city && city.toLowerCase().includes('johannesburg')) {
      cName = 'África do Sul';
      lat = -26.20;
      lon = 28.04;
    }
    const loc = countryLocations[cName] || { lat: -18.66, lon: 35.52, code: 'MZ' };
    return {
      country: cName,
      city: city,
      viewers: v.viewers || 1,
      lat: lat !== null ? lat : loc.lat,
      lon: lon !== null ? lon : loc.lon
    };
  });

  const recentRows = db.prepare(`
    SELECT visitor_id, country, device, os, browser, city, timezone,
           MAX(created_at) as last_seen, event_type
    FROM analytics_events
    WHERE video_id = ? AND created_at >= datetime('now', '-2 hours')
      AND visitor_id NOT LIKE 'test_vis%'
    GROUP BY visitor_id
    ORDER BY last_seen DESC
    LIMIT 50
  `).all(vidId);

  const now = Date.now();
  const recent = recentRows.map(r => {
    const rawC = r.country || '';
    let normC = rawC === 'Mozambique' ? 'Moçambique' : (rawC || 'Moçambique');
    let city = r.city || '';
    if (r.timezone === 'Africa/Maputo' || normC === 'Moçambique' || (city && city.toLowerCase().includes('luanda') && normC === 'Angola')) {
      normC = 'Moçambique';
      city = (!city || city.toLowerCase().includes('luanda') || city.toLowerCase().includes('johannesburg')) ? 'Maputo' : city;
    } else if (city && city.toLowerCase().includes('johannesburg')) {
      normC = 'África do Sul';
    }
    return {
      visitorShort: r.visitor_id ? r.visitor_id.slice(0, 8) : '?',
      country: normC,
      city: city,
      device: r.device || 'desktop',
      os: r.os || '',
      browser: r.browser || '',
      lastEvent: r.event_type,
      minutesAgo: Math.round((now - new Date(r.last_seen + 'Z').getTime()) / 60000)
    };
  });

  res.json({
    activeNow: activeRows.c || 0,
    activeViewers,
    recent
  });
});

app.delete('/api/analytics/video/:id/reset', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const video = db.prepare('SELECT id, user_id FROM videos WHERE id = ? AND deleted_at IS NULL').get(vidId);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && video.user_id !== req.user.id) return res.status(403).json({ error: 'Permissão negada.' });

  db.prepare('DELETE FROM analytics_events WHERE video_id = ?').run(vidId);
  db.prepare('UPDATE videos SET plays = 0 WHERE id = ?').run(vidId);

  res.json({ success: true });
});



app.post('/api/upload', authMiddleware, checkStorageQuotaPre, (req, res) => {
  upload.single('videoFile')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Falha no upload do arquivo.' });
    }

    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const originalPath = req.file.path;
    const isOwner = req.user.role === 'owner';
    const userUsed = getUserStorageBytes(req.user.id);
    const initialSize = fs.statSync(originalPath).size;

    if (!isOwner && (userUsed + initialSize > MEMBER_STORAGE_LIMIT_BYTES)) {
      try { fs.unlinkSync(originalPath); } catch (e) {}
      return res.status(400).json({ error: 'Cota individual de 3 GB atingida. Remova vídeos para liberar espaço.' });
    }

    const currentUsed = getUsedStorageBytes();
    if (currentUsed > SERVER_STORAGE_LIMIT_BYTES) {
      try { fs.unlinkSync(originalPath); } catch (e) {}
      return res.status(400).json({ error: 'Capacidade do servidor esgotada.' });
    }

    const finalStat = fs.statSync(originalPath);

    if (!isOwner && (userUsed + finalStat.size > MEMBER_STORAGE_LIMIT_BYTES)) {
      try { fs.unlinkSync(originalPath); } catch (e) {}
      return res.status(400).json({ error: 'Cota individual de 3 GB excedida para este vídeo.' });
    }

    const host = req.get('host') || '';
    const isProd = host.includes(BASE_DOMAIN);
    const videoDomain = isProd ? `https://${PLAYER_DOMAIN}` : `${req.protocol}://${host}`;
    const videoUrl = `${videoDomain}/videos/${req.file.filename}`;

    const probedDuration = getVideoDurationFormatted(originalPath);

    res.json({
      success: true,
      filename: req.file.filename,
      filePath: originalPath,
      fileSize: finalStat.size,
      duration: probedDuration || null,
      videoUrl: videoUrl
    });
  });
});

app.get('/api/google/config', authMiddleware, (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const apiKey = process.env.GOOGLE_API_KEY || '';
  const appId = clientId ? clientId.split('-')[0] : '';
  res.json({
    enabled: Boolean(clientId && apiKey),
    clientId,
    apiKey,
    appId
  });
});

app.post('/api/upload/google-drive', authMiddleware, checkStorageQuotaPre, async (req, res) => {
  const { fileId, accessToken, title, folderId } = req.body || {};
  if (!fileId || !accessToken) {
    return res.status(400).json({ error: 'Parâmetros fileId e accessToken são obrigatórios.' });
  }

  const isOwner = req.user.role === 'owner';
  const userUsed = getUserStorageBytes(req.user.id);

  try {
    const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!metaRes.ok) {
      const errText = await metaRes.text();
      return res.status(metaRes.status).json({ error: 'Erro ao consultar arquivo no Google Drive: ' + errText });
    }

    const meta = await metaRes.json();
    if (meta.mimeType && !meta.mimeType.startsWith('video/')) {
      return res.status(400).json({ error: 'O arquivo selecionado no Google Drive não é um vídeo válido.' });
    }
    const declaredSize = parseInt(meta.size || '0', 10);

    if (!isOwner && declaredSize > 0 && (userUsed + declaredSize > MEMBER_STORAGE_LIMIT_BYTES)) {
      return res.status(400).json({ error: 'Cota individual de 3 GB atingida. Remova vídeos para liberar espaço.' });
    }

    const currentUsed = getUsedStorageBytes();
    if (declaredSize > 0 && (currentUsed + declaredSize > SERVER_STORAGE_LIMIT_BYTES)) {
      return res.status(400).json({ error: 'Capacidade do servidor esgotada.' });
    }

    const ext = meta.name && path.extname(meta.name) ? path.extname(meta.name) : '.mp4';
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const targetPath = path.join(VIDEOS_DIR, filename);

    const streamRes = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!streamRes.ok) {
      return res.status(streamRes.status).json({ error: 'Falha ao baixar conteúdo do Google Drive.' });
    }

    const fileStream = fs.createWriteStream(targetPath);
    await finished(Readable.fromWeb(streamRes.body).pipe(fileStream));

    const finalStat = fs.statSync(targetPath);

    if (!isOwner && (userUsed + finalStat.size > MEMBER_STORAGE_LIMIT_BYTES)) {
      try { fs.unlinkSync(targetPath); } catch (e) {}
      return res.status(400).json({ error: 'Cota individual de 3 GB excedida para este vídeo.' });
    }

    const host = req.get('host') || '';
    const isProd = host.includes(BASE_DOMAIN);
    const videoDomain = isProd ? `https://${PLAYER_DOMAIN}` : `${req.protocol}://${host}`;
    const videoUrl = `${videoDomain}/videos/${filename}`;

    const cleanTitle = (title || meta.name || 'Vídeo do Google Drive').replace(/\.[^/.]+$/, '').trim().slice(0, 70);
    const vidId = 'vsl_' + Date.now();

    let cleanFolderId = null;
    if (folderId && folderId !== 'root') {
      const folder = db.prepare('SELECT id, user_id FROM folders WHERE id = ?').get(folderId);
      if (folder && (req.user.role === 'owner' || folder.user_id === req.user.id)) {
        cleanFolderId = folder.id;
      }
    }

    const defaultSettings = {
      barColor: '#2563EB',
      borderRadius: '16px',
      aspectRatio: '16:9',
      smartAutoplay: true,
      autoplayText: 'Seu vídeo ja iniciou\\nClique para escutar',
      fakeProgress: true,
      blockSeek: true,
      ctaEnabled: false,
      ctaTime: 10,
      ctaText: '',
      ctaUrl: '',
      ctaColor: '#10b981',
      ctaSubtext: '',
      resume: true,
      pixels: false
    };

    const realDuration = getVideoDurationFormatted(targetPath);

    db.prepare(`
      INSERT INTO videos (id, user_id, folder_id, title, source_type, file_path, file_size, video_url, duration, settings_json, status, optimization_progress)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vidId,
      req.user.id,
      cleanFolderId,
      cleanTitle,
      'local',
      targetPath,
      finalStat.size,
      videoUrl,
      realDuration || null,
      JSON.stringify(defaultSettings),
      'optimizing',
      15
    );

    processVideoHLS(vidId);

    dispatchWebhookEvent(req.user.id, 'video.upload.completed', {
      video_id: vidId,
      name: cleanTitle,
      size_bytes: finalStat.size,
      source: 'google_drive'
    });
    dispatchWebhookEvent(req.user.id, 'video.created', {
      video_id: vidId,
      name: cleanTitle,
      size_bytes: finalStat.size,
      source: 'google_drive'
    });

    res.json({
      success: true,
      id: vidId,
      title: cleanTitle,
      videoUrl,
      fileSize: finalStat.size
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao importar do Google Drive: ' + err.message });
  }
});

app.options('/videos/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Accept-Ranges, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  res.status(204).end();
});

app.get('/videos/:id/:file', (req, res) => {
  const vidId = path.basename(req.params.id);
  const fileName = path.basename(req.params.file);
  const filePath = path.join(VIDEOS_DIR, vidId, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Arquivo não encontrado.');
  }

  const stat = fs.statSync(filePath);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Accept-Ranges, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');

  if (fileName.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return fs.createReadStream(filePath).pipe(res);
  }

  if (fileName.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return fs.createReadStream(filePath).pipe(res);
  }

  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || fileName.endsWith('.png') || fileName.endsWith('.webp')) {
    const cType = fileName.endsWith('.png') ? 'image/png' : (fileName.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    res.setHeader('Content-Type', cType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return fs.createReadStream(filePath).pipe(res);
  }

  if (fileName.endsWith('.mp4')) {
    res.setHeader('Content-Type', 'video/mp4');
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      if (end >= stat.size) end = stat.size - 1;
      const chunksize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*'
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      });
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  res.sendFile(filePath);
});

app.get('/videos/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  let filePath = path.join(VIDEOS_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    try {
      const v = db.prepare("SELECT id, file_path FROM videos WHERE video_url LIKE ? OR file_path LIKE ?").get(`%${safeFilename}%`, `%${safeFilename}%`);
      if (v) {
        if (v.file_path && fs.existsSync(v.file_path)) {
          filePath = v.file_path;
        } else {
          const inSub = path.join(VIDEOS_DIR, v.id, safeFilename);
          if (fs.existsSync(inSub)) {
            filePath = inSub;
          } else {
            const hlsDir = path.join(VIDEOS_DIR, v.id);
            if (fs.existsSync(hlsDir)) {
              const files = fs.readdirSync(hlsDir);
              const mp4 = files.find(f => f.endsWith('.mp4'));
              if (mp4 && fs.existsSync(path.join(hlsDir, mp4))) {
                filePath = path.join(hlsDir, mp4);
              }
            }
          }
        }
      }
    } catch (e) {}
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Vídeo não encontrado.');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Accept-Ranges, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');

  const contentType = safeFilename.endsWith('.webm') ? 'video/webm' : 'video/mp4';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (end >= fileSize) end = fileSize - 1;

    if (start >= fileSize) {
      res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
      return;
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable'
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.get('*', (req, res) => {
  const host = (req.headers.host || '').toLowerCase();
  if (HELP_DOMAIN && (host === HELP_DOMAIN || host.startsWith('help.'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'help.html'));
  }
  if (req.path === '/help' || req.path === '/ajuda' || req.path.startsWith('/pt-br/article/') || req.path.startsWith('/help/')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'help.html'));
  }
  if (req.path === '/convite' || req.path.startsWith('/convite/')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'convite.html'));
  }
  if (req.path === '/analytics-api' || req.path.startsWith('/analytics-api/')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'analytics-api.html'));
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`${APP_NAME} ativo na porta ${PORT}`);
});
