const STORAGE_KEY = 'game-builder-agent-chat-v1';
const configuredApiBase = document.querySelector('meta[name="api-base-url"]')?.content.trim();
const API_BASE = configuredApiBase || '/api';
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const messageList = document.getElementById('chat-messages');
const welcome = document.getElementById('welcome');
const typing = document.getElementById('typing-indicator');
const sendButton = document.getElementById('send-button');
let messages = loadMessages();
let busy = false;

function loadMessages() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function saveMessages() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40)));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function renderArtifact(artifact, approval) {
  if (!artifact) return '';
  const buildItems = (artifact.buildSheet || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const assetItems = (artifact.assetList || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const code = artifact.code
    ? `<section class="artifact-section"><h3>Code · ${escapeHtml(artifact.language || 'Code')}</h3><p class="placement">${escapeHtml(artifact.placement || 'Follow the placement steps above.')}</p><pre class="code-block"><code>${escapeHtml(artifact.code)}</code></pre></section>`
    : '';
  const liveAction = approval
    ? `<section class="artifact-section"><h3>Roblox live action · approval required</h3><p>${escapeHtml(approval.description || 'Review the exact request before approving it.')}</p><pre class="payload">${escapeHtml(JSON.stringify(approval.payload, null, 2))}</pre><div class="artifact-actions"><button class="action-button" type="button" data-approve="${escapeHtml(approval.id)}">Approve and send</button><button class="action-button secondary" type="button" data-reject="${escapeHtml(approval.id)}">Do not send</button></div></section>`
    : '';
  const liveResult = artifact.liveResult
    ? `<section class="artifact-section"><h3>Roblox live result</h3><p class="live-status">${escapeHtml(artifact.liveResult)}</p></section>`
    : '';
  const diagnosis = artifact.diagnosis
    ? `<section class="artifact-section"><h3>What went wrong</h3><p>${escapeHtml(artifact.diagnosis)}</p></section>`
    : '';
  return `<div class="artifact">${buildItems ? `<section class="artifact-section"><h3>Build Sheet</h3><ol>${buildItems}</ol></section>` : ''}${code}${assetItems ? `<section class="artifact-section"><h3>Asset List</h3><ul>${assetItems}</ul></section>` : ''}${diagnosis}${liveResult}${liveAction}${artifact.code ? `<div class="artifact-actions"><button class="action-button" type="button" data-save="${escapeHtml(artifact.project || 'game-build')}">Save code to GitHub</button></div>` : ''}</div>`;
}

function renderMessages() {
  welcome.hidden = messages.length > 0;
  messageList.replaceChildren();
  messages.forEach((message, index) => {
    const item = document.createElement('article');
    item.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
    const body = document.createElement('div');
    body.className = 'message-body';
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = message.text;
    body.append(bubble);
    if (message.artifact) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = renderArtifact(message.artifact, message.approval);
      body.append(wrapper);
    }
    if (message.saved) {
      const saved = document.createElement('p');
      saved.className = 'live-status';
      saved.textContent = message.saved;
      body.append(saved);
    }
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = message.role === 'user' ? 'Y' : '✦';
    item.append(avatar, body);
    messageList.append(item);
    if (index === messages.length - 1) item.scrollIntoView({ block: 'nearest' });
  });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => toast.classList.remove('show'), 3500);
}

function setBusy(value) {
  busy = value;
  input.disabled = value;
  sendButton.disabled = value;
  typing.hidden = !value;
}

async function postJson(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `The request failed (${response.status}).`);
  return result;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  if (/\b(?:api[\s_-]?key|access[\s_-]?token|password|client[\s_-]?secret)\s*[:=]\s*\S+|(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AIza[a-z0-9_-]{30,}|xox[baprs]-[a-z0-9-]{15,})/i.test(text)) {
    showToast('Please remove the credential before sending. Keep keys in the server environment only.');
    return;
  }

  messages.push({ role: 'user', text });
  input.value = '';
  input.style.height = 'auto';
  renderMessages();
  saveMessages();
  setBusy(true);

  try {
    const result = await postJson('/game-chat', {
      messages: messages.slice(-24).map(message => ({
        role: message.role,
        text: (message.role === 'assistant' && message.artifact
          ? `${message.text}\n\n${JSON.stringify(message.artifact)}`
          : message.text).slice(0, 8000)
      }))
    });
    const artifact = result.artifact || null;
    const text = result.message || 'I’m ready to help with your game.';
    messages.push({ role: 'assistant', text, artifact, approval: result.approval || null });
    saveMessages();
    renderMessages();
  } catch (error) {
    messages.push({ role: 'assistant', text: `I couldn’t reach the chat service. ${error.message}` });
    saveMessages();
    renderMessages();
    showToast(error.message);
  } finally {
    setBusy(false);
    input.focus();
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 190)}px`;
});

input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

messageList.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || busy) return;
  const messageNode = button.closest('.message');
  const message = messages[Array.from(messageList.children).indexOf(messageNode)];
  if (!message) return;

  if (button.dataset.save) {
    button.disabled = true;
    button.textContent = 'Saving to GitHub...';
    try {
      const result = await postJson('/game-artifacts', {
        game: message.artifact.game,
        project: message.artifact.project || button.dataset.save,
        language: message.artifact.language,
        placement: message.artifact.placement,
        code: message.artifact.code,
        buildSheet: message.artifact.buildSheet,
        assetList: message.artifact.assetList
      });
      message.saved = `Saved to GitHub: ${result.files.join(', ')}`;
      saveMessages();
      renderMessages();
      showToast('Your code is saved in GitHub.');
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Save code to GitHub';
      showToast(error.message);
    }
    return;
  }

  const approvalId = button.dataset.approve || button.dataset.reject;
  if (!approvalId) return;
  button.disabled = true;
  button.textContent = button.dataset.approve ? 'Sending after approval...' : 'Declining...';
  try {
    const result = await postJson(`/roblox/approvals/${encodeURIComponent(approvalId)}`, {
      decision: button.dataset.approve ? 'approve' : 'reject'
    });
    message.approval = null;
    message.artifact.liveResult = result.message;
    saveMessages();
    renderMessages();
    showToast(result.message);
  } catch (error) {
    button.disabled = false;
    button.textContent = button.dataset.approve ? 'Approve and send' : 'Do not send';
    showToast(error.message);
  }
});

renderMessages();
