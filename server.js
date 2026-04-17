require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(session);
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;
const hasDatabase = Boolean(process.env.DATABASE_URL);

// ── DATABASE ──
let pool = null;
let sessionStore = null;

if (hasDatabase) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  sessionStore = new PgSession({ pool, createTableIfMissing: true, errorLog: console.error });
} else {
  console.warn('DATABASE_URL not set. Using in-memory sessions and disabling saved projects.');
}

async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255),
        name VARCHAR(255),
        avatar VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255),
        description TEXT,
        html TEXT,
        updated_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}
initDB();

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'buildai-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: false },
};

if (sessionStore) {
  sessionConfig.store = sessionStore;
}

app.use(session(sessionConfig));

app.use(passport.initialize());
app.use(passport.session());

// ── PASSPORT ──
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL || '/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  if (!pool) return done(null, false);
  try {
    const email = profile.emails?.[0]?.value;
    const avatar = profile.photos?.[0]?.value;
    const res = await pool.query(
      `INSERT INTO users (google_id, email, name, avatar)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_id) DO UPDATE SET name=$3, avatar=$4
       RETURNING *`,
      [profile.id, email, profile.displayName, avatar]
    );
    done(null, res.rows[0]);
  } catch (err) { done(err); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  if (!pool) return done(null, false);
  try {
    const res = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
    done(null, res.rows[0] || false);
  } catch (err) { done(err); }
});

// ── AUTH ROUTES ──
function requireGoogleAuthSetup(req, res, next) {
  if (!pool) return res.redirect('/builder?error=database');
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.redirect('/builder?error=google-auth');
  }
  next();
}

app.get('/auth/google', requireGoogleAuthSetup, passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  requireGoogleAuthSetup,
  passport.authenticate('google', { failureRedirect: '/?error=auth' }),
  (req, res) => res.redirect('/builder')
);

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).send(`<h1>Something went wrong</h1><p>${err.message || 'Unknown error'}</p><a href="/">Go home</a>`);
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { name: req.user.name, email: req.user.email, avatar: req.user.avatar } });
});

// ── PROJECTS API ──
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireDatabase(req, res, next) {
  if (!pool) {
    return res.status(503).json({
      error: 'Database is not configured. Add DATABASE_URL to enable saved projects and Google sign-in.',
    });
  }
  next();
}

app.get('/api/projects', requireDatabase, requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, title, description, updated_at FROM projects WHERE user_id=$1 ORDER BY updated_at DESC',
    [req.user.id]
  );
  res.json(result.rows);
});

app.post('/api/projects', requireDatabase, requireAuth, async (req, res) => {
  const { title, description, html } = req.body;
  const result = await pool.query(
    `INSERT INTO projects (user_id, title, description, html)
     VALUES ($1, $2, $3, $4) RETURNING id, title, description, updated_at`,
    [req.user.id, title || 'Untitled', description || '', html]
  );
  res.json(result.rows[0]);
});

app.put('/api/projects/:id', requireDatabase, requireAuth, async (req, res) => {
  const { title, description, html } = req.body;
  const result = await pool.query(
    `UPDATE projects SET title=$1, description=$2, html=$3, updated_at=NOW()
     WHERE id=$4 AND user_id=$5 RETURNING id, title, description, updated_at`,
    [title, description, html, req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(result.rows[0]);
});

app.get('/api/projects/:id', requireDatabase, requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM projects WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(result.rows[0]);
});

app.delete('/api/projects/:id', requireDatabase, requireAuth, async (req, res) => {
  await pool.query('DELETE FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ── AI GENERATION ──
const SYSTEM_PROMPT = `You are a world-class UI/UX designer and senior front-end developer. You create websites that look like they were made by a top design agency like Awwwards winners.

You MUST respond with ONLY a JSON object. No markdown, no code blocks, no extra text.

Format:
{"html":"<full HTML here>","title":"Site Title","description":"One sentence description"}

DESIGN RULES — follow these strictly:
- Use a bold, unique color palette (not generic blue/white). Pick colors that match the brand personality.
- Large, impactful hero section with a bold headline, subtext, and a CTA button
- Use Google Fonts — pick a pairing: one display font for headings, one clean font for body
- CSS custom properties for all colors and fonts
- Smooth scroll-triggered animations using Intersection Observer API
- Subtle glassmorphism, gradients, or frosted effects where appropriate
- Micro-interactions: hover effects, button transitions, card lifts
- Use CSS Grid and Flexbox for layout — no tables
- Add Font Awesome icons (CDN) for visual richness
- Sections must include: navbar, hero, features/services, about/story, testimonials or gallery, contact/CTA, footer
- Use real placeholder images from https://picsum.photos (e.g. <img src="https://picsum.photos/seed/WORD/800/500">)
- Every section must have generous padding, clear visual hierarchy, and breathing room
- Mobile responsive with hamburger menu on small screens
- The final result must look STUNNING — like a $10,000 agency website

TECHNICAL RULES:
- Single complete HTML file, all CSS and JS embedded
- No external JS frameworks (no React, Vue, etc.)
- All images use picsum.photos with relevant seed words
- Hamburger menu must work with vanilla JS`;

app.post('/api/generate', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Messages array required' });
  if (!process.env.GOOGLE_API_KEY) return res.status(500).json({ error: 'GOOGLE_API_KEY not set in Railway variables' });

  try {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { responseMimeType: 'application/json' },
    });

    const history = messages.slice(0, -1).map(m => {
      let content = m.content;
      if (m.role === 'assistant') {
        try {
          const p = JSON.parse(content);
          content = JSON.stringify({ title: p.title, description: p.description, html: '[previous website]' });
        } catch {}
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] };
    });

    const lastMessage = messages[messages.length - 1].content;
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(lastMessage);
    let raw = result.response.text().trim();

    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    if (!raw.startsWith('{')) raw = '{' + raw;
    if (!raw.endsWith('}')) raw = raw + '}';

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return res.status(500).json({ error: 'AI returned invalid JSON. Please try again.' }); }

    res.json(parsed);
  } catch (err) {
    console.error('Google AI error:', err.message);
    res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

// ── PUBLISH ──
const publishedSites = new Map();

app.post('/api/publish', (req, res) => {
  const { html, title } = req.body;
  if (!html) return res.status(400).json({ error: 'No HTML provided' });
  const slug = (title || 'my-site')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 40)
    + '-' + Math.random().toString(36).substring(2, 7);
  publishedSites.set(slug, { html, title });
  res.json({ slug, url: `/site/${slug}` });
});

app.get('/site/:slug', (req, res) => {
  const site = publishedSites.get(req.params.slug);
  if (!site) return res.status(404).send('<h1>Site not found</h1>');
  res.setHeader('Content-Type', 'text/html');
  res.send(site.html);
});

// ── PAGES ──
app.get('/builder', (req, res) => res.sendFile(path.join(__dirname, 'public', 'builder.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  const message = err?.message || 'Unexpected server error';
  console.error('Server error:', message);
  res.status(500).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 AI Website Builder running at http://localhost:${PORT}`);
  console.log(`   Builder: http://localhost:${PORT}/builder\n`);
});
