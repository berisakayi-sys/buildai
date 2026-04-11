require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory site storage
const sites = new Map();

const SYSTEM_PROMPT = `You are an expert web developer and UI/UX designer. Generate complete, beautiful websites.

You MUST respond with ONLY a JSON object. No markdown, no code blocks, no extra text.

Format:
{"html":"<full HTML here>","title":"Site Title","description":"One sentence description"}

HTML rules:
- Complete single HTML file with embedded CSS and JS
- Visually stunning: gradients, animations, modern typography
- Fully responsive (mobile-first)
- Navigation bar, hero section, at least 3 content sections
- Load fonts from Google Fonts CDN
- No external JS frameworks`;

app.post('/api/generate', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array required' });
  }

  if (!process.env.GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'API key not configured. Add GOOGLE_API_KEY to your Railway variables.' });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });

    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const lastMessage = messages[messages.length - 1].content;

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(lastMessage);
    let raw = result.response.text().trim();

    // Strip code fences
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    if (!raw.startsWith('{')) raw = '{' + raw;
    if (!raw.endsWith('}')) raw = raw + '}';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return res.status(500).json({ error: 'AI returned invalid JSON. Please try again.' });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Google AI error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Publish a site
app.post('/api/publish', (req, res) => {
  const { html, title } = req.body;
  if (!html) return res.status(400).json({ error: 'No HTML provided' });

  // Generate slug from title
  const slug = (title || 'my-site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40) + '-' + Math.random().toString(36).substring(2, 7);

  sites.set(slug, { html, title, createdAt: new Date() });

  res.json({ slug, url: `/site/${slug}` });
});

// Serve a published site
app.get('/site/:slug', (req, res) => {
  const site = sites.get(req.params.slug);
  if (!site) return res.status(404).send('<h1>Site not found</h1><p>This site may have expired.</p>');
  res.setHeader('Content-Type', 'text/html');
  res.send(site.html);
});

app.get('/builder', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'builder.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 AI Website Builder running at http://localhost:${PORT}`);
  console.log(`   Landing page:  http://localhost:${PORT}/`);
  console.log(`   AI Builder:    http://localhost:${PORT}/builder\n`);
});
