const GROQ_KEY = process.env.GROQ_API_KEY;
const CHAT_MODEL = 'llama-3.3-70b-versatile';
const WHISPER_MODEL = 'whisper-large-v3';

async function chat(messages, opts = {}) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model: opts.model || CHAT_MODEL,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens || 4096,
      response_format: opts.json ? { type: 'json_object' } : undefined
    })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Groq error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content;
}

// Transcribe a voice note / audio buffer to text using Groq's Whisper endpoint.
// Whisper auto-detects the spoken language and can also auto-translate to English
// if opts.translate is true (uses the /translations endpoint instead).
async function transcribeAudio(buffer, filename = 'audio.ogg', opts = {}) {
  const endpoint = opts.translate
    ? 'https://api.groq.com/openai/v1/audio/translations'
    : 'https://api.groq.com/openai/v1/audio/transcriptions';

  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
    body: form
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Groq whisper error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return { text: (data.text || '').trim(), language: data.language || null };
}

module.exports = { chat, transcribeAudio };
