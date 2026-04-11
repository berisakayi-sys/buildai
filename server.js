require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

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

    console.log('RAW (first 300):', raw.substring(0, 300));

    // Strip code fences
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Ensure it starts and ends with braces
    if (!raw.startsWith('{')) raw = '{' + raw;
    if (!raw.endsWith('}')) raw = raw + '}';

    // Validate it parses correctly
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Try to extract html/title/description manually
      const htmlMatch = raw.match(/"html"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"title"|"\s*})/);
      const titleMatch = raw.match(/"title"\s*:\s*"([^"]+)"/);
      const descMatch = raw.match(/"description"\s*:\s*"([^"]+)"/);

      if (htmlMatch) {
        parsed = {
          html: htmlMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
          title: titleMatch ? titleMatch[1] : 'Generated Website',
          description: descMatch ? descMatch[1] : 'Website generated successfully',
        };
        raw = JSON.stringify(parsed);
      } else {
        throw new Error('Could not parse Gemini response as JSON');
      }
    }

    res.write(`data: ${JSON.stringify({ text: raw })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Google AI error:', err.message);
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
