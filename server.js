require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are an expert web developer and UI/UX designer. Your job is to generate complete, beautiful, production-ready websites from user descriptions.

When the user describes a website they want, you MUST respond with ONLY a valid JSON object in this exact format:
{
  "html": "<the complete HTML file as a string>",
  "title": "<short title of what was built>",
  "description": "<one sentence describing what was built>"
}

Rules for the generated HTML:
- Generate a COMPLETE single HTML file with all CSS and JavaScript embedded
- Make it visually stunning with modern design: gradients, animations, clean typography
- Use a cohesive color palette based on the site's purpose
- Include smooth hover effects, transitions, and micro-interactions
- Make it fully responsive (mobile-first)
- Use modern CSS features: flexbox, grid, custom properties, animations
- Add realistic placeholder content that fits the website type
- Include a navigation bar, hero section, and at least 3 content sections
- Make fonts and icons load from CDN (Google Fonts, Font Awesome)
- NO external JavaScript frameworks — pure HTML/CSS/JS only
- The site should look like it was made by a professional agency

If the user asks to modify or update the site, generate a complete new version with the requested changes.
If the user asks a question (not requesting a site), respond with a helpful message in this JSON format:
{
  "html": null,
  "title": null,
  "description": "<your helpful response here>"
}`;

// Streaming endpoint
app.post('/api/generate', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array required' });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'API key not configured. Add GROQ_API_KEY to your Railway variables.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await client.chat.completions.create({
      model: 'qwen/qwen3-32b',
      max_tokens: 5000,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('OpenAI API error:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
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
