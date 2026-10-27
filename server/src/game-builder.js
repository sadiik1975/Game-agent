import fs from 'node:fs';
import path from 'node:path';

export function loadGameManuals(directory) {
  return fs.readdirSync(directory)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const manual = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      if (!manual.id || !manual.name || !manual.language || !manual.extension ||
          !manual.instructions || !Array.isArray(manual.aliases) || manual.aliases.length === 0) {
        throw new Error(`Invalid game manual: ${file}`);
      }
      return manual;
    });
}

export function detectGame(messages, manuals) {
  const userMessages = messages.filter(message => message.role === 'user');
  for (const message of userMessages.reverse()) {
    const userText = (message.text || message.content || '').toLowerCase();
    const selected = manuals.find(manual => manual.aliases.some(alias => {
      const escaped = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(userText);
    }));
    if (selected) return selected;
  }
  return null;
}

export function redactSecrets(text) {
  return String(text)
    .replace(/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AIza[a-z0-9_-]{30,}|xox[baprs]-[a-z0-9-]{15,})\b/gi, '[redacted secret]')
    .replace(/\b(api[\s_-]?key|access[\s_-]?token|password|client[\s_-]?secret)\s*[:=]\s*["']?[^"'\s,;]+["']?/gi, '$1=[redacted]');
}

export function buildGameSystemPrompt(manual, robloxKeyConfigured) {
  return [
    'You are Game Builder Agent, a friendly chat-first game development assistant. Talk naturally, do not require commands, and never claim to have edited an external project unless a tool result confirms it.',
    `Selected game manual (${manual.name}, ${manual.language}): ${manual.instructions}`,
    'For a build, fix, or behavior request, respond only with one valid JSON object with these keys: message (brief conversational explanation), diagnosis (plain-language cause or empty string), project (short project name), buildSheet (array of numbered strings), language, placement (exact editor path and script type), code (complete code string), assetList (array of assets; use an empty array when none), and liveAction (null or a structured Roblox action).',
    'Keep buildSheet, code, placement, and assetList complete and usable. For Fortnite clearly say the user performs the steps. Do not promise that generated code has been tested. For metrics, prioritize the weakest supplied metric and recommend only human UEFN/editor or promotion actions. Explain adult-account-only actions and route them to the adult account holder.',
    'For Roblox liveAction use exactly one of: {"type":"read_datastore","universeId":"...","datastoreName":"...","entryKey":"..."} or {"type":"announcement","universeId":"...","topic":"...","message":"..."}. Do not add a liveAction unless the user asks for a real live operation and supplies the needed identifiers/message. Reads may be performed immediately by the server. Writes must only be proposed for approval; never imply they were sent.',
    `Roblox Open Cloud key configured on the server: ${robloxKeyConfigured ? 'yes' : 'no'}. If a live action is requested without a configured key, explain this in message and give manual steps; do not include a liveAction.`,
    'If the user pastes an error, explain it plainly in diagnosis, then return corrected code and placement. If the user reports broken behavior, diagnosis should include a short relevant checklist before the fix.',
    'Never ask for, repeat, or put API keys, tokens, passwords, or other credentials into your response or code. Do not repeat sensitive values from user messages.'
  ].join('\n\n');
}

export function getConfiguredChatProviders(env) {
  const providers = [];
  if (env.XAI_API_KEY) {
    providers.push({
      provider: 'xai',
      baseUrl: env.XAI_API_URL || 'https://api.x.ai/v1',
      apiKey: env.XAI_API_KEY,
      model: env.XAI_MODEL || 'grok-4.20-0309-non-reasoning'
    });
  }
  if (env.GROQ_API_KEY) {
    providers.push({
      provider: 'groq',
      baseUrl: env.GROQ_API_URL || 'https://api.groq.com/openai/v1',
      apiKey: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || 'qwen/qwen3.8-27b'
    });
  }
  if (env.OPENROUTER_API_KEY) {
    providers.push({
      provider: 'openrouter',
      baseUrl: env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || 'openrouter/free'
    });
  }
  return providers;
}

export function parseBuildResponse(raw) {
  const content = String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const artifact = JSON.parse(content);
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('The model response was not a JSON object.');
  }
  if (typeof artifact.message !== 'string' ||
      !Array.isArray(artifact.buildSheet) ||
      artifact.buildSheet.length === 0 ||
      !Array.isArray(artifact.assetList) ||
      typeof artifact.code !== 'string' ||
      typeof artifact.placement !== 'string' ||
      !artifact.placement.trim()) {
    throw new Error('The model response did not include a complete build sheet, code, placement, and asset list.');
  }
  return artifact;
}

export function slugify(value, fallback = 'game-build') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

export function validateRobloxAction(action) {
  if (!action || typeof action !== 'object') return null;
  const universeId = String(action.universeId || '');
  if (!/^\d{1,20}$/.test(universeId)) return null;

  if (action.type === 'read_datastore') {
    const datastoreName = String(action.datastoreName || '').trim();
    const entryKey = String(action.entryKey || '').trim();
    if (!datastoreName || datastoreName.length > 200 || !entryKey || entryKey.length > 200) return null;
    return { type: action.type, universeId, datastoreName, entryKey };
  }

  if (action.type === 'announcement') {
    const topic = String(action.topic || '').trim();
    const message = String(action.message || '').trim();
    if (!topic || topic.length > 80 || !message || message.length > 1000) return null;
    return { type: action.type, universeId, topic, message };
  }

  return null;
}
