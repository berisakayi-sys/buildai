require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const OpenAI = require('openai');
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(session);
const cors = require('cors');
const path = require('path');
const https = require('https');

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
const SYSTEM_PROMPT = `You are a world-class UI/UX designer and senior front-end developer. You design websites at the level of top Dribbble shots — the kind that get thousands of likes and go trending. Every site you build should look like it could be featured on Dribbble, Awwwards, or Behance.

CRITICAL OUTPUT RULE: You MUST respond with ONLY a raw JSON object. Absolutely no markdown, no code fences, no backticks, no explanations, no text before or after the JSON. Your entire response must start with { and end with }. Any extra text will break the parser.

Format:
{"html":"<full HTML here>","title":"Site Title","description":"One sentence description"}

DRIBBBLE-INSPIRED DESIGN RULES — follow these strictly:

VISUAL STYLE:
- Study and replicate the aesthetic of top Dribbble UI kits: bold typography, strong visual hierarchy, editorial layouts, generous whitespace with purpose
- DARK MODE ONLY — deep blacks and near-blacks (#0a0a0a, #0f0f13, #0d0d1a, #080810). Never use white or light backgrounds.
- Pick a signature accent color palette (2-3 colors max) that matches the brand — e.g. electric violet + cyan, rose gold + dark navy, neon green + charcoal
- Use large, expressive typography — oversized headings (clamp(3rem, 8vw, 7rem)), thin subheadings, tight letter-spacing on display text

LAYOUT PATTERNS (pick styles trending on Dribbble):
- Bento grid layouts for features (asymmetric cards of varying sizes)
- Split hero: bold text left, large image or 3D-style card right
- Diagonal or angled section dividers using clip-path
- Horizontal scrolling marquee/ticker for logos or stats
- Full-bleed image sections with text overlay
- Staggered card grids with hover tilt effect

EFFECTS & POLISH:
- Glassmorphism cards: backdrop-filter: blur(16px), rgba(255,255,255,0.04) background, 1px rgba(255,255,255,0.08) border
- Glowing accent orbs in backgrounds: large blurred radial-gradient circles (400-600px, 15-25% opacity) in the accent color
- Glowing CTA buttons: gradient background + box-shadow glow in accent color
- Sticky glassmorphism navbar with blur
- Smooth entrance animations via Intersection Observer (fade-up, slide-in, scale-in)
- Hover micro-interactions: card lift (translateY -8px), glow intensify, image zoom

TYPOGRAPHY:
- Google Fonts — always pick a premium-feeling pair: one bold display font (e.g. Playfair Display, Syne, Clash Display via @import, Bebas Neue, DM Serif Display) + one clean body font (e.g. Inter, DM Sans, Outfit)
- Mix font weights dramatically: 900 for hero, 300 for subtext, 600 for labels

PHOTOS — MANDATORY:
- Every section must have at least one image. No text-only sections.
- Hero: large image (picsum 1200x700) with subtle dark overlay, or split layout with image on one side
- Feature/bento cards: each card has its own image (picsum 600x400)
- About: atmospheric full-width image (picsum 1400x600) with overlay text
- Gallery: masonry or grid of at least 6 photos (picsum 400x300, 400x500, 400x250 — mix portrait and landscape)
- Testimonials: circular avatar photos (picsum 100x100 with different seeds)
- All images: use https://picsum.photos/seed/WORD/W/H with seeds matching the brand topic. Use at least 12 unique seeds.
- Images get a subtle dark overlay (::after pseudo-element or wrapper div with rgba(0,0,0,0.3)) to fit the dark theme

SECTIONS REQUIRED: sticky navbar, hero, features/bento grid, about/story with image, gallery or portfolio, testimonials with avatars, contact/CTA, footer with links

TECHNICAL RULES:
- Single complete HTML file, all CSS and JS embedded
- No external JS frameworks (no React, Vue, etc.)
- Font Awesome CDN for icons
- All images use picsum.photos — minimum 12 images total
- Hamburger menu works with vanilla JS
- CSS custom properties for all design tokens
- The result must look so good it could trend on Dribbble today`;

app.post('/api/generate', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Messages array required' });
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY not set in Railway variables' });

  try {
    const client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://buildai-production-017c.up.railway.app',
        'X-Title': 'BuildAI',
      },
    });

    const chatMessages = messages.map(m => {
      let content = m.content;
      if (m.role === 'assistant') {
        try {
          const p = JSON.parse(content);
          content = JSON.stringify({ title: p.title, description: p.description, html: '[previous website]' });
        } catch {}
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
    });

    const result = await client.chat.completions.create({
      model: 'openrouter/auto',
      max_tokens: 8000,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...chatMessages],
    });

    let raw = result.choices[0].message.content.trim();

    // Strip markdown fences
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Try direct parse first
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      // Extract the outermost {...} block (handles text before/after JSON)
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch (_2) {
          // Last resort: pull out fields manually
          const htmlMatch = raw.match(/"html"\s*:\s*"([\s\S]*?)"\s*,\s*"title"/);
          const titleMatch = raw.match(/"title"\s*:\s*"([^"]+)"/);
          const descMatch = raw.match(/"description"\s*:\s*"([^"]+)"/);
          if (htmlMatch && titleMatch) {
            parsed = {
              html: htmlMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
              title: titleMatch[1],
              description: descMatch ? descMatch[1] : '',
            };
          } else {
            console.error('Raw AI response:', raw.substring(0, 500));
            return res.status(500).json({ error: 'AI returned invalid JSON. Please try again.' });
          }
        }
      } else {
        console.error('Raw AI response:', raw.substring(0, 500));
        return res.status(500).json({ error: 'AI returned invalid JSON. Please try again.' });
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error('OpenRouter error:', err.message);
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

// ── TOOL API ──
const TOOL_CONFIGS = {
  chat:         { system: 'You are a helpful, friendly, and knowledgeable AI assistant. Be concise and accurate. Use markdown for formatting when helpful.', returns: 'text' },
  logo:         { system: 'Generate a professional SVG logo based on the user\'s description. Respond with ONLY valid SVG code, no markdown, no explanation. Start with <svg and end with </svg>. Use viewBox="0 0 200 200". Include gradients, modern shapes, and the brand name as text. Make it stunning.', returns: 'svg' },
  content:      { system: 'You are a professional content writer. Write engaging, well-structured long-form content. Use clear headings, paragraphs, and strong hooks. Be thorough.', returns: 'text' },
  resume:       { system: 'Generate a complete, professional resume as a single HTML file with embedded CSS. Dark/light clean design, proper sections: summary, experience, skills, education. Return ONLY the HTML, no markdown.', returns: 'html' },
  code:         { system: 'You are an expert programmer. Write clean, well-commented, production-ready code. Briefly explain your approach, then provide the full code.', returns: 'text' },
  email:        { system: 'You are a professional email copywriter. Write compelling, clear emails with subject line, greeting, body, and sign-off. Format it clearly.', returns: 'text' },
  social:       { system: 'You are a social media expert. Create highly engaging posts for the requested platform with hooks, emojis where appropriate, and relevant hashtags. Generate multiple variants.', returns: 'text' },
  names:        { system: 'You are a creative brand naming expert. Generate 10 unique, memorable business names. For each: name in bold, one-line tagline, why it works, and a .com domain suggestion.', returns: 'text' },
  palette:      { system: 'Generate a beautiful color palette as a complete HTML page with embedded CSS. Show 6 colors as large swatches with hex codes, RGB values, and usage tips. Use a dark background. Return ONLY valid HTML starting with <!DOCTYPE html>.', returns: 'html' },
  seo:          { system: 'You are an SEO expert. Provide: 1) SEO title tag, 2) meta description, 3) target keywords list, 4) full SEO-optimized article with H1/H2/H3 structure. Be thorough.', returns: 'text' },
  presentation: { system: 'Generate a complete HTML presentation with 6+ slides. Use embedded CSS with a stunning dark design, gradient backgrounds, large typography. Include prev/next navigation buttons via JS. Return ONLY the complete HTML file starting with <!DOCTYPE html>.', returns: 'html' },
  image:        { system: 'You are an expert at writing AI image generation prompts. Write 5 detailed, vivid image prompts based on the user\'s description. For each prompt: describe style, lighting, colors, composition, mood, and technical details. Format each as a numbered prompt ready to paste into Midjourney or DALL-E.', returns: 'text' },
};

app.post('/api/tool', async (req, res) => {
  const { tool, messages } = req.body;
  if (!tool || !messages) return res.status(400).json({ error: 'tool and messages required' });
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY not set' });

  const config = TOOL_CONFIGS[tool];
  if (!config) return res.status(400).json({ error: 'Unknown tool' });

  try {
    const client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: { 'HTTP-Referer': 'https://buildai-production-017c.up.railway.app', 'X-Title': 'BuildAI' },
    });

    const result = await client.chat.completions.create({
      model: 'openrouter/auto',
      max_tokens: 4000,
      messages: [{ role: 'system', content: config.system }, ...messages],
    });

    let output = result.choices[0].message.content.trim();

    // Strip markdown fences for html/svg returns
    if (config.returns === 'html' || config.returns === 'svg') {
      output = output.replace(/^```html\s*/i, '').replace(/^```svg\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    }

    res.json({ output, returns: config.returns });
  } catch (err) {
    console.error('Tool API error:', err.message);
    res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

// ── HF VIDEO GENERATION ──
function hfPost(model, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'api-inference.huggingface.co',
      path: `/models/${model}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        contentType: response.headers['content-type'] || 'video/mp4',
        buffer: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function handleHfVideo(prompt, model, res) {
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  if (!process.env.HF_TOKEN) return res.status(500).json({ error: 'HF_TOKEN not set in environment' });
  try {
    const hf = await hfPost(model, process.env.HF_TOKEN, { inputs: prompt });
    if (hf.status === 503) {
      let wait = 20;
      try { const j = JSON.parse(hf.buffer.toString()); wait = Math.ceil(j.estimated_time || 20); } catch {}
      return res.status(503).json({ error: 'model_loading', estimated_time: wait });
    }
    if (hf.status !== 200) {
      return res.status(500).json({ error: hf.buffer.toString() });
    }
    res.set('Content-Type', hf.contentType);
    res.set('Content-Disposition', 'inline; filename="video.mp4"');
    res.send(hf.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Catch redirected HF requests that land on /models/* directly
app.post('/models/:org/:repo', (req, res) => {
  const model = `${req.params.org}/${req.params.repo}`;
  const prompt = req.body?.inputs || req.body?.prompt || '';
  handleHfVideo(prompt, model, res);
});

app.post('/api/video', async (req, res) => {
  const { prompt, model = 'damo-vilab/text-to-video-ms-1.7b' } = req.body;
  handleHfVideo(prompt, model, res);
});

// ── PAGES ──
app.get('/builder', (req, res) => res.sendFile(path.join(__dirname, 'public', 'builder.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/tools', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools.html')));
app.get('/media-maker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'media-maker.html')));
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
