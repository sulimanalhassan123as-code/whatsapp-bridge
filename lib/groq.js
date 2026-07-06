const GROQ_KEY = process.env.GROQ_API_KEY;
const CHAT_MODEL = 'llama-3.3-70b-versatile';

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

module.exports = { chat };
