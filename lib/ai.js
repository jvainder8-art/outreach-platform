const axios = require('axios');

async function generate(aiConfig, systemPrompt, userPrompt) {
  const apiKey = process.env[aiConfig.apiKeyEnvVar];
  if (!apiKey) throw new Error(`Missing env var: ${aiConfig.apiKeyEnvVar}`);

  if (aiConfig.provider === 'gemini') {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${aiConfig.model}:generateContent?key=${apiKey}`,
      { contents: [{ parts: [{ text: userPrompt }] }] },
      { timeout: 10000 }
    );
    return res.data.candidates[0].content.parts[0].text.trim();
  }

  if (aiConfig.provider === 'claude') {
    const body = {
      model: aiConfig.model,
      max_tokens: aiConfig.maxTokens || 600,
      messages: [{ role: 'user', content: userPrompt }],
    };
    if (systemPrompt) body.system = systemPrompt;

    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      body,
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 15000,
      }
    );
    return res.data.content[0].text.trim();
  }

  throw new Error(`Unknown AI provider: ${aiConfig.provider}`);
}

module.exports = { generate };
