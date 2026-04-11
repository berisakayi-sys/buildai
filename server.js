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

    const history = messages.slice(0, -1).map(m => {
      let content = m.content;
      // Strip the html field from assistant messages to keep history small
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
