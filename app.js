const STORAGE_KEY = 'my-personal-business-agent-v1';
const DEFAULT_ACCENT = '#10a7a0';
const configuredApiBase = document.querySelector('meta[name="api-base-url"]')?.content.trim();
const API_BASE = configuredApiBase || (window.location.port === '4173' ? `${window.location.protocol}//${window.location.hostname}:8787/api` : '/api');

const initialState = {
  workflows: [],
  activities: [],
  emailPriorities: {},
  inboxPriorityFilter: 'all',
  newsSkills: '',
  awaitingNewsSkills: false,
  pendingNewsOpportunity: null,
  newsCategory: 'all',
  autoReplyHighPriority: false,
  highPriorityReplyTemplate: 'Thanks for your email. I have received it and will review it soon.',
  autoRepliedMessageIds: [],
  dark: false,
  accent: DEFAULT_ACCENT,
  hooks: { google: false, linkedin: false, telegram: false },
  voiceResponses: false,
  speechVoice: '',
  policies: {
    email: 'ask',
    social: 'ask',
    linkedin: 'ask'
  },
  response: {
    title: 'Connect a source to get live business data.',
    summary: 'Your assistant is ready, but it will not invent emails, leads, or meetings.'
  },
  chat: [
    { role: 'assistant', text: 'I am ready. Ask me about your opportunities, email, leads, meetings, or today\'s priorities.' }
  ]
};

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const value = clean.length === 3
    ? clean.split('').map(char => char + char).join('')
    : clean;

  const number = Number.parseInt(value, 16);
  return {
    r: (number >> 16) & 255,
    g: (number >> 8) & 255,
    b: number & 255
  };
}

function mixHexColors(baseHex, mixHex, weight = 0.5) {
  const a = hexToRgb(baseHex);
  const b = hexToRgb(mixHex);
  const amount = 1 - weight;

  const r = Math.round(a.r * amount + b.r * weight);
  const g = Math.round(a.g * amount + b.g * weight);
  const bValue = Math.round(a.b * amount + b.b * weight);

  return `rgb(${r}, ${g}, ${bValue})`;
}

function applyAccent(color) {
  const accent = color || DEFAULT_ACCENT;
  const root = document.documentElement;
  root.style.setProperty('--primary', accent);
  root.style.setProperty('--secondary', mixHexColors(accent, '#ffffff', 0.38));
  root.style.setProperty('--primary-rgb', hexToRgb(accent).r + ', ' + hexToRgb(accent).g + ', ' + hexToRgb(accent).b);

  const picker = document.getElementById('accent-color-picker');
  if (picker) {
    picker.value = accent;
  }

  document.querySelectorAll('.swatch').forEach(button => {
    const isActive = button.dataset.accent.toLowerCase() === accent.toLowerCase();
    button.classList.toggle('active', isActive);
  });
}

let state = loadState();
let sessionProviderKey = '';
let isChatBusy = false;
const inFlightEmailReplies = new Set();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const accent = saved.accent && saved.accent.toLowerCase() !== '#5f5ae8'
      ? saved.accent
      : DEFAULT_ACCENT;
    return {
      ...initialState,
      ...saved,
      accent,
      hooks: { ...initialState.hooks, ...saved.hooks },
      policies: { ...initialState.policies, ...saved.policies }
    };
  } catch {
    return { ...initialState };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function applyPolicies() {
  Object.entries(state.policies || {}).forEach(([policy, value]) => {
    const select = document.querySelector(`[data-policy="${policy}"]`);
    if (select) select.value = value;
  });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => toast.classList.remove('show'), 2200);
}

function setActiveTab(tab) {
  const labels = { chat: 'Chat', news: 'News', ideas: 'Ideas', inbox: 'Inbox', content: 'Content' };
  document.body.dataset.tab = tab;
  document.getElementById('page-title').textContent = labels[tab] || 'Chat';
  document.querySelectorAll('.bottom-tab').forEach(button => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-view').forEach(view => {
    const active = view.id === `${tab}-view`;
    view.classList.toggle('active', active);
    view.hidden = !active;
  });
  if (tab === 'inbox') loadInbox();
  if (tab === 'news') loadNews();
  if (tab === 'content') loadContent();
}

function setDrawerOpen(open) {
  document.body.classList.toggle('drawer-open', open);
  document.getElementById('control-drawer').setAttribute('aria-hidden', String(!open));
  if (open) document.getElementById('drawer-close').focus();
}

function setProviderAvailability(available) {
  const status = document.querySelector('.live-status');
  status.dataset.state = available ? 'ready' : 'limited';
  status.lastElementChild.textContent = available ? 'Workspace online' : 'Model temporarily busy';
  document.querySelector('.drawer-bottom strong').textContent = available ? 'Ready' : 'Provider busy';
}

async function generateIdea() {
  const button = document.getElementById('generate-idea');
  button.disabled = true;
  button.textContent = 'Checking live news...';
  try {
    const newsResponse = await fetch(`${API_BASE}/news?refresh=1`, { signal: AbortSignal.timeout(20000) });
    const newsResult = await newsResponse.json();
    if (!newsResponse.ok || !newsResult.articles?.length) throw new Error(newsResult.error || 'No live headlines are available right now.');
    const articles = newsResult.articles.slice(0, 5);
    if (!state.newsSkills.trim()) {
      state.pendingNewsOpportunity = {
        title: 'A live scan of AI, robotics, markets, and crypto news',
        summary: articles.map(article => `${article.categoryLabel}: ${article.title}. ${article.summary || ''} Source: ${article.source} (${article.url})`).join('\n'),
        source: 'Live news feeds',
        url: ''
      };
      state.awaitingNewsSkills = true;
      state.chat.push({ role: 'user', text: 'Find me a practical business opportunity in today’s live news.' });
      state.chat.push({ role: 'assistant', text: 'I’ve checked the latest headlines. What skills, services, or experience should I use to find an opportunity that fits you? Type your answer or use the microphone.' });
      saveState();
      setActiveTab('chat');
      renderChat();
      document.getElementById('command-input').focus();
      return;
    }

    button.textContent = 'Building an idea...';
    const prompt = `Look at these current headlines and suggest one realistic business opportunity I could test this week using my skills. My skills, work, and goals are in the saved context. Pick the most relevant headline, explain the customer problem, suggest a simple paid offer, and give me one first step. Keep it conversational and concise, with no bullet list. Do not give investment advice or guarantee returns. Headlines:\n${articles.map(article => `- ${article.categoryLabel}: ${article.title}. ${article.summary || ''} Source: ${article.source} (${article.url})`).join('\n')}`;
    const response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sessionProviderKey ? { 'x-openrouter-api-key': sessionProviderKey } : {}) },
      signal: AbortSignal.timeout(65000),
      body: JSON.stringify({ messages: [{ role: 'user', text: prompt }], businessContext: state.newsSkills.slice(0, 2000) })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The assistant could not create an idea.');

    const article = articles[0];
    const card = document.createElement('article');
    card.className = 'idea-card generated-idea';
    const number = document.createElement('span');
    number.className = 'idea-number';
    number.textContent = 'LIVE';
    const content = document.createElement('div');
    const tag = document.createElement('span');
    tag.className = 'idea-tag';
    tag.textContent = `LIVE NEWS · ${article.categoryLabel || 'BUSINESS'}`;
    const title = document.createElement('h3');
    title.textContent = `Opportunity from ${article.source || 'today’s news'}`;
    const body = document.createElement('div');
    body.className = 'generated-idea-copy';
    renderFormattedMessage(body, result.text);
    const footer = document.createElement('div');
    footer.className = 'idea-footer';
    const source = document.createElement('span');
    source.textContent = `Based on: ${article.title}`;
    const explore = document.createElement('button');
    explore.className = 'idea-use';
    explore.type = 'button';
    explore.textContent = 'Continue in chat';
    explore.addEventListener('click', () => applyCommand(`Help me take the next step on this live-news business idea: ${result.text} Source story: ${article.title} (${article.url})`));
    footer.append(source, explore);
    content.append(tag, title, body, footer);
    card.append(number, content);
    document.getElementById('ideas-empty')?.remove();
    document.getElementById('ideas-list').prepend(card);
    showToast(result.provider === 'groq' ? 'Live idea created with Groq.' : 'Live idea created.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>✳</span> Generate an idea';
  }
}

function setView(view) {
  const labels = {
    command: 'Home',
    search: 'Search',
    calendar: 'Calendar',
    inbox: 'Inbox',
    contacts: 'Contacts',
    business: 'Business',
    automation: 'Automation',
    settings: 'Settings',
    activity: 'Activity'
  };

  const title = labels[view] || 'Home';
  document.getElementById('page-title').textContent = title;
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  document.body.dataset.view = view;

  const focusTargets = {
    business: { selector: '.revenue-panel', message: 'Business view: move the next opportunity forward.' },
    automation: { selector: '#autonomy-controls', message: 'Automation view: choose what can happen automatically.' },
    settings: { selector: '#autonomy-controls', message: 'Settings: review your approval rules.' },
    activity: { selector: '.activity-strip', message: 'Activity: review what the assistant has done.' }
  };

  if (view === 'command') {
    const commandArea = document.querySelector('.command-area');
    const input = document.getElementById('command-input');
    commandArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => input.focus(), 180);
    showToast('Command center is ready. What should I take care of?');
    return;
  }

  if (view === 'inbox') {
    document.getElementById('inbox-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
    loadInbox();
    return;
  }

  if (['search', 'calendar', 'contacts'].includes(view)) {
    const input = document.getElementById('command-input');
    input.value = view === 'search' ? 'Search my connected business data' : `Help me with my ${view}`;
    input.focus();
    input.select();
    showToast(`${title} is ready in the assistant. Connect a provider for live ${view} data.`);
    return;
  }

  const target = focusTargets[view];
  if (target) {
    document.querySelector(target.selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast(target.message);
    return;
  }

  showToast(`${title} is available from the command center.`);
}

function renderWorkflows() {
  const list = document.getElementById('workflow-list');
  list.innerHTML = state.workflows.length ? state.workflows.map(workflow => {
    const progress = Math.min(100, Math.round((workflow.completed / workflow.total) * 100));
    return `
      <div class="workflow-item">
        <div class="workflow-marker">✦</div>
        <div class="workflow-copy">
          <strong>${workflow.name}</strong>
          <span>${workflow.next}</span>
        </div>
        <div class="workflow-progress">
          <small>${workflow.completed}/${workflow.total}</small>
          <div class="progress-bar"><span style="width:${progress}%"></span></div>
        </div>
      </div>
    `;
  }).join('') : '<p class="empty-state">No workflows have been created yet.</p>';
}

function renderActivity() {
  const list = document.getElementById('activity-list');
  const markup = state.activities.length ? state.activities.map(item => `
    <div class="activity-item">
      <strong>${item.text}</strong>
      <small>${item.time}</small>
    </div>
  `).join('') : '<p class="empty-state">No activity recorded yet.</p>';
  list.innerHTML = markup;
  document.getElementById('notification-activity').innerHTML = markup;
}

function renderIntegrations(integrations) {
  const list = document.getElementById('integration-list');
  if (!list) return;
  list.replaceChildren();
  integrations.forEach(integration => {
    const item = document.createElement('div');
    item.className = 'integration-item';
    const action = integration.provider === 'outlook'
      ? '<button class="secondary-action integration-action" type="button" id="outlook-inbox">Load inbox</button>'
      : integration.provider === 'gmail'
        ? '<button class="secondary-action integration-action" type="button" id="gmail-connect">Connect Gmail</button>'
        : `<span class="status-badge ${integration.configured ? 'success' : 'warning'}">${integration.configured ? 'Ready' : 'Setup needed'}</span>`;
    item.innerHTML = `<span class="integration-logo ${integration.provider}">${integration.provider[0].toUpperCase()}</span><div><strong>${integration.label}</strong><p>${integration.detail}</p></div>${action}`;
    list.appendChild(item);
  });
}

let inboxMessages = [];
let inboxProvider = 'gmail';

async function submitGmailReply(message, body, automatic = false) {
  if (!body || state.autoRepliedMessageIds.includes(message.id) || inFlightEmailReplies.has(message.id)) return false;
  inFlightEmailReplies.add(message.id);
  try {
    const response = await fetch(`${API_BASE}/gmail/messages/${encodeURIComponent(message.id)}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Gmail could not send the reply.');
    state.autoRepliedMessageIds = [...new Set([...state.autoRepliedMessageIds, message.id])];
    saveState();
    if (!automatic) showToast('Email reply sent.');
    return true;
  } catch (error) {
    showToast(automatic ? `Auto-reply failed: ${error.message}` : error.message);
    return false;
  } finally {
    inFlightEmailReplies.delete(message.id);
  }
}

async function processHighPriorityAutoReplies(messages) {
  if (!state.autoReplyHighPriority) return;
  let sentCount = 0;
  for (const message of messages) {
    if ((state.emailPriorities[message.id] || 'normal') !== 'high') continue;
    if (await submitGmailReply(message, state.highPriorityReplyTemplate.trim(), true)) sentCount += 1;
  }
  if (sentCount) showToast(`Sent ${sentCount} high-priority auto-repl${sentCount === 1 ? 'y' : 'ies'}.`);
}

function sendGmailReply(message, textarea, button) {
  const body = textarea.value.trim();
  if (!body || button.disabled) return;
  button.disabled = true;
  button.textContent = 'Sending...';
  submitGmailReply(message, body).then(sent => {
    if (sent) {
      textarea.value = '';
      button.textContent = 'Reply sent';
      return;
    }
    button.disabled = false;
    button.textContent = 'Send reply';
  });
}

function renderEmailResults(messages, provider = 'gmail') {
  inboxMessages = messages;
  inboxProvider = provider;
  const list = document.getElementById('inbox-list');
  list.replaceChildren();
  const priorities = { high: 0, normal: 1, low: 2 };
  const filter = document.getElementById('inbox-priority-filter')?.value || state.inboxPriorityFilter || 'all';
  const ordered = [...messages]
    .sort((a, b) => priorities[state.emailPriorities[a.id] || 'normal'] - priorities[state.emailPriorities[b.id] || 'normal'] || new Date(b.receivedDateTime) - new Date(a.receivedDateTime))
    .filter(message => filter === 'all' || (state.emailPriorities[message.id] || 'normal') === filter);
  if (!ordered.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = messages.length ? 'No emails match this priority filter.' : `Your ${provider === 'gmail' ? 'Gmail' : 'Outlook'} inbox is empty.`;
    list.appendChild(empty);
    return;
  }
  ordered.forEach(message => {
    const priority = state.emailPriorities[message.id] || 'normal';
    const item = document.createElement('article');
    item.className = `email-item priority-${priority}${message.isRead ? '' : ' unread'}`;

    const marker = document.createElement('span');
    marker.className = `result-icon ${message.isRead ? 'success' : 'attention'}`;
    marker.setAttribute('aria-label', message.isRead ? 'Read' : 'Unread');
    const content = document.createElement('div');
    content.className = 'email-content';
    const heading = document.createElement('div');
    heading.className = 'email-heading';
    const subject = document.createElement('strong');
    subject.textContent = message.subject || '(no subject)';
    const prioritySelect = document.createElement('select');
    prioritySelect.className = 'email-priority';
    prioritySelect.setAttribute('aria-label', `Priority for ${message.subject || 'email'}`);
    [['high', 'High'], ['normal', 'Normal'], ['low', 'Low']].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      prioritySelect.appendChild(option);
    });
    prioritySelect.value = priority;
    prioritySelect.addEventListener('change', () => {
      state.emailPriorities[message.id] = prioritySelect.value;
      saveState();
      renderEmailResults(inboxMessages, inboxProvider);
      if (prioritySelect.value === 'high' && inboxProvider === 'gmail') processHighPriorityAutoReplies([message]);
    });
    heading.append(subject, prioritySelect);
    const sender = document.createElement('span');
    sender.className = 'email-sender';
    const received = new Date(message.receivedDateTime);
    sender.textContent = `${message.from?.emailAddress?.address || 'Unknown sender'} · ${Number.isNaN(received.getTime()) ? '' : received.toLocaleString()}`;
    const preview = document.createElement('p');
    preview.className = 'email-preview';
    preview.textContent = message.bodyPreview || message.bodyText || '';
    content.append(heading, sender, preview);

    const details = document.createElement('details');
    details.className = 'email-details';
    const summary = document.createElement('summary');
    summary.textContent = `Read full email${message.images?.length ? ` · ${message.images.length} image${message.images.length === 1 ? '' : 's'}` : ''}`;
    details.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'email-body';
    let htmlDocument = null;
    if (message.bodyHtml) htmlDocument = new DOMParser().parseFromString(message.bodyHtml, 'text/html');
    const htmlText = htmlDocument?.body.textContent.trim();
    body.textContent = message.bodyText && message.bodyText !== message.bodyPreview
      ? message.bodyText
      : htmlText || message.bodyText || message.bodyPreview || 'No readable text content.';
    details.appendChild(body);
    if (message.images?.length) {
      const gallery = document.createElement('div');
      gallery.className = 'email-images';
      message.images.forEach(image => {
        const figure = document.createElement('figure');
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = image.filename || 'Image attached to email';
        img.src = `${API_BASE}/gmail/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(image.attachmentId)}?mime=${encodeURIComponent(image.mimeType)}`;
        figure.appendChild(img);
        if (image.filename) {
          const caption = document.createElement('figcaption');
          caption.textContent = image.filename;
          figure.appendChild(caption);
        }
        gallery.appendChild(figure);
      });
      details.appendChild(gallery);
    }
    const remoteImageUrls = [...new Set((htmlDocument ? Array.from(htmlDocument.querySelectorAll('img')) : [])
      .map(image => image.getAttribute('src') || image.getAttribute('data-src'))
      .filter(Boolean)
      .map(source => {
        try {
          const url = new URL(source, window.location.origin);
          return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
        } catch {
          return '';
        }
      })
      .filter(Boolean))];
    if (remoteImageUrls.length) {
      const remoteGallery = document.createElement('div');
      remoteGallery.className = 'email-images';
      const loadPictures = document.createElement('button');
      loadPictures.className = 'secondary-action';
      loadPictures.type = 'button';
      loadPictures.textContent = `Load ${remoteImageUrls.length} remote picture${remoteImageUrls.length === 1 ? '' : 's'}`;
      loadPictures.title = 'External pictures may notify the sender when they load.';
      loadPictures.addEventListener('click', () => {
        remoteImageUrls.forEach((source, index) => {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.alt = `Email picture ${index + 1}`;
          img.src = source;
          remoteGallery.appendChild(img);
        });
        loadPictures.remove();
      }, { once: true });
      details.append(loadPictures, remoteGallery);
    }
    if (provider === 'gmail') {
      const composer = document.createElement('div');
      composer.className = 'email-reply';
      const textarea = document.createElement('textarea');
      textarea.rows = 3;
      textarea.maxLength = 10000;
      textarea.placeholder = 'Write a reply...';
      textarea.setAttribute('aria-label', `Reply to ${message.subject || 'email'}`);
      const sendButton = document.createElement('button');
      sendButton.className = 'secondary-action';
      sendButton.type = 'button';
      sendButton.textContent = 'Send reply';
      sendButton.addEventListener('click', () => sendGmailReply(message, textarea, sendButton));
      composer.append(textarea, sendButton);
      details.appendChild(composer);
    }
    content.appendChild(details);
    item.append(marker, content);
    list.appendChild(item);
  });
}

let newsArticles = [];

function renderNews() {
  const list = document.getElementById('news-list');
  const filter = document.getElementById('news-category-filter').value || 'all';
  const categoryLabels = { ai: 'AI & agents', robotics: 'Robotics', markets: 'Markets & stocks', crypto: 'Crypto' };
  const articles = newsArticles.filter(article => filter === 'all' || article.category === filter);
  list.replaceChildren();
  if (!articles.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = newsArticles.length ? 'No live stories for this topic.' : 'No headlines are available right now. Try refreshing.';
    list.appendChild(empty);
    return;
  }
  articles.forEach(article => {
    const item = document.createElement('article');
    item.className = 'live-news-item';
    const metadata = document.createElement('div');
    metadata.className = 'live-news-meta';
    const category = document.createElement('span');
    category.textContent = categoryLabels[article.category] || article.categoryLabel || 'News';
    const time = document.createElement('time');
    const published = article.publishedAt ? new Date(article.publishedAt) : null;
    time.textContent = published && !Number.isNaN(published.getTime()) ? published.toLocaleString() : 'Recently published';
    metadata.append(category, time);
    const title = document.createElement('h3');
    if (article.url) {
      const link = document.createElement('a');
      link.href = article.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = article.title;
      title.appendChild(link);
    } else {
      title.textContent = article.title;
    }
    const summary = document.createElement('p');
    summary.textContent = article.summary || 'Open the source for details.';
    const footer = document.createElement('div');
    footer.className = 'live-news-footer';
    const source = document.createElement('span');
    source.textContent = article.source || 'News source';
    const monetize = document.createElement('button');
    monetize.type = 'button';
    monetize.className = 'secondary-action';
    monetize.textContent = 'Monetize this';
    monetize.addEventListener('click', () => {
      state.pendingNewsOpportunity = {
        title: article.title,
        summary: article.summary || '',
        source: article.source || '',
        url: article.url || ''
      };
      if (!state.newsSkills.trim()) {
        state.awaitingNewsSkills = true;
        state.chat.push({ role: 'user', text: `Help me find a business opportunity in this story: ${article.title}` });
        state.chat.push({ role: 'assistant', text: 'What skills or services can you offer? Type your answer below, or use the microphone button to say it. I’ll save your answer and use it to suggest a practical way to monetize this story.' });
        saveState();
        setActiveTab('chat');
        renderChat();
        document.getElementById('command-input').focus();
        return;
      }
      const prompt = `Help me find one realistic, low-cost way to monetize this news using my skills. My skills/services: ${state.newsSkills.trim()}. News: ${article.title}. Summary: ${article.summary || 'No summary provided.'} Source: ${article.source || 'Unknown'} (${article.url || 'no link'}). Suggest a specific customer, offer, and first action. Treat this as business opportunity research, not investment advice; do not recommend buying or selling assets or guarantee returns.`;
      setActiveTab('chat');
      applyCommand(prompt);
    });
    footer.append(source, monetize);
    item.append(metadata, title, summary, footer);
    list.appendChild(item);
  });
}

async function loadNews(forceRefresh = false) {
  const status = document.getElementById('news-status');
  const refresh = document.getElementById('refresh-news');
  refresh.disabled = true;
  status.textContent = forceRefresh ? 'Refreshing live news...' : 'Loading live news...';
  try {
    const response = await fetch(`${API_BASE}/news${forceRefresh ? '?refresh=1' : ''}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'News could not be loaded.');
    newsArticles = result.articles || [];
    renderNews();
    const updated = result.updatedAt ? new Date(result.updatedAt).toLocaleTimeString() : 'just now';
    const unavailable = result.unavailable?.length ? ` · Unavailable: ${result.unavailable.join(', ')}` : '';
    status.textContent = `${newsArticles.length} headlines · Updated ${updated}${unavailable}`;
  } catch (error) {
    newsArticles = [];
    renderNews();
    status.textContent = error.message;
  } finally {
    refresh.disabled = false;
  }
}

let contentPosts = [];
let contentNotifications = [];
let contentStatus = null;

function renderContentQueue() {
  const list = document.getElementById('content-post-queue');
  list.replaceChildren();
  if (!contentPosts.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No posts yet. Save a draft or schedule your first post.';
    list.appendChild(empty);
    return;
  }
  contentPosts.forEach(post => {
    const item = document.createElement('article');
    item.className = 'content-post-item';
    const info = document.createElement('div');
    info.className = 'content-post-info';
    const meta = document.createElement('span');
    meta.textContent = `${post.platform === 'linkedin' ? 'LinkedIn' : 'Telegram'} · ${post.status}${post.scheduled_at ? ` · ${new Date(post.scheduled_at).toLocaleString()}` : ''}`;
    const text = document.createElement('p');
    text.textContent = post.content;
    info.append(meta, text);
    if (post.error) {
      const error = document.createElement('small');
      error.className = 'content-post-error';
      error.textContent = post.error;
      info.appendChild(error);
    }
    const actions = document.createElement('div');
    actions.className = 'content-post-actions';
    if (['draft', 'scheduled', 'failed'].includes(post.status)) {
      const publish = document.createElement('button');
      publish.type = 'button';
      publish.className = 'secondary-action';
      publish.textContent = 'Publish now';
      publish.addEventListener('click', () => publishContentNow(post.id, publish));
      actions.appendChild(publish);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'content-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => removeContentPost(post.id));
      actions.appendChild(remove);
    }
    item.append(info, actions);
    list.appendChild(item);
  });
}

function renderContentNotifications() {
  const list = document.getElementById('content-notifications');
  list.replaceChildren();
  if (!contentNotifications.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No post responses yet.';
    list.appendChild(empty);
    return;
  }
  contentNotifications.forEach(notification => {
    const item = document.createElement('article');
    item.className = `content-notification${notification.read_at ? '' : ' unread'}`;
    const heading = document.createElement('div');
    heading.className = 'content-notification-heading';
    const sender = document.createElement('strong');
    sender.textContent = notification.sender || 'Telegram user';
    const time = document.createElement('time');
    time.textContent = new Date(notification.created_at).toLocaleString();
    heading.append(sender, time);
    const message = document.createElement('p');
    message.textContent = notification.message;
    item.append(heading, message);
    if (notification.auto_replied) {
      const reply = document.createElement('small');
      reply.textContent = 'Auto-reply sent';
      item.appendChild(reply);
    } else if (!notification.read_at) {
      const markRead = document.createElement('button');
      markRead.type = 'button';
      markRead.className = 'content-remove';
      markRead.textContent = 'Mark read';
      markRead.addEventListener('click', () => markContentNotificationRead(notification.id));
      item.appendChild(markRead);
    }
    list.appendChild(item);
  });
}

function renderContentStatus() {
  if (!contentStatus) return;
  const platforms = contentStatus.platforms || {};
  document.getElementById('linkedin-content-status').textContent = platforms.linkedin?.connected ? 'Connected · posting enabled' : platforms.linkedin?.detail || 'Not connected';
  document.getElementById('telegram-content-status').textContent = platforms.telegram?.connected ? 'Connected · publishing and replies available' : platforms.telegram?.detail || 'Not connected';
  document.getElementById('content-daily-count').textContent = `${contentStatus.scheduledToday || 0} of ${contentStatus.dailyLimit || 10} posts scheduled or published today.`;
  document.getElementById('telegram-auto-reply').checked = Boolean(contentStatus.telegramAutoReply);
  document.getElementById('telegram-reply-template').value = contentStatus.telegramAutoReplyTemplate || '';
}

async function loadContent() {
  try {
    const [statusResponse, postsResponse, notificationsResponse] = await Promise.all([
      fetch(`${API_BASE}/content/status`),
      fetch(`${API_BASE}/content/posts`),
      fetch(`${API_BASE}/content/notifications`)
    ]);
    const [status, posts, notifications] = await Promise.all([statusResponse.json(), postsResponse.json(), notificationsResponse.json()]);
    if (!statusResponse.ok || !postsResponse.ok || !notificationsResponse.ok) throw new Error(status.error || 'Content could not be loaded.');
    contentStatus = status;
    contentPosts = posts;
    contentNotifications = notifications;
    renderContentStatus();
    renderContentQueue();
    renderContentNotifications();
  } catch (error) {
    document.getElementById('content-status').textContent = error.message;
  }
}

async function submitContentPost(action) {
  const content = document.getElementById('content-post-text').value.trim();
  const platform = document.getElementById('content-platform').value;
  const localDate = document.getElementById('content-scheduled-at').value;
  if (!content) {
    showToast('Write the post text first.');
    return;
  }
  if (action === 'schedule' && !localDate) {
    showToast('Choose a date and time to schedule this post.');
    return;
  }
  const response = await fetch(`${API_BASE}/content/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, platform, action, scheduledAt: localDate ? new Date(localDate).toISOString() : null })
  });
  const result = await response.json();
  if (!response.ok) {
    document.getElementById('content-status').textContent = result.error || 'Post could not be saved.';
    return;
  }
  document.getElementById('content-post-text').value = '';
  document.getElementById('content-status').textContent = action === 'schedule' ? 'Post scheduled. It will publish when the selected platform is connected.' : 'Draft saved.';
  showToast(action === 'schedule' ? 'Post scheduled.' : 'Draft saved.');
  await loadContent();
}

async function publishContentNow(id, button) {
  button.disabled = true;
  const response = await fetch(`${API_BASE}/content/posts/${encodeURIComponent(id)}/publish`, { method: 'POST' });
  const result = await response.json();
  if (!response.ok) {
    showToast(result.error || 'Post could not be published.');
    button.disabled = false;
    return;
  }
  showToast('Post published.');
  await loadContent();
}

async function removeContentPost(id) {
  const response = await fetch(`${API_BASE}/content/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) {
    showToast(result.error || 'Post could not be removed.');
    return;
  }
  await loadContent();
}

async function markContentNotificationRead(id) {
  const response = await fetch(`${API_BASE}/content/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
  if (response.ok) await loadContent();
}

async function generateContentDraft() {
  const button = document.getElementById('generate-content-draft');
  button.disabled = true;
  button.textContent = 'Finding a live angle...';
  try {
    const response = await fetch(`${API_BASE}/news`);
    const result = await response.json();
    if (!response.ok || !result.articles?.length) throw new Error(result.error || 'No live news is available to draft from.');
    const articles = result.articles.slice(0, 5);
    const chatResponse = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sessionProviderKey ? { 'x-openrouter-api-key': sessionProviderKey } : {}) },
      body: JSON.stringify({ businessContext: state.newsSkills, messages: [{ role: 'user', text: `Write one original social post for ${document.getElementById('content-platform').value} based on a relevant current headline. Use my saved business context. Keep it accurate, useful, conversational, and under 1,000 characters; no fabricated claims and no investment advice. Headlines:\n${articles.map(article => `${article.title}: ${article.summary}`).join('\n')}` }] })
    });
    const draft = await chatResponse.json();
    if (!chatResponse.ok) throw new Error(draft.error || 'The assistant could not draft a post.');
    document.getElementById('content-post-text').value = draft.text;
    document.getElementById('content-status').textContent = `Draft suggestion from ${draft.provider || 'assistant'}; review it before saving or scheduling.`;
  } catch (error) {
    document.getElementById('content-status').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Draft from live news';
  }
}

async function loadGmailInbox() {
  try {
    document.getElementById('inbox-status').textContent = 'Loading Gmail messages...';
    const response = await fetch(`${API_BASE}/gmail/inbox`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Gmail inbox could not be loaded.');
    renderEmailResults(result, 'gmail');
    document.getElementById('inbox-status').textContent = `${result.length} messages loaded from Gmail.`;
    showToast(`${result.length} Gmail messages loaded.`);
    await processHighPriorityAutoReplies(result);
  } catch (error) {
    showToast(error.message);
    document.getElementById('inbox-status').textContent = error.message;
    document.getElementById('inbox-list').innerHTML = `<p class="empty-state">${error.message}</p>`;
  }
}

async function loadOutlookInbox() {
  try {
    document.getElementById('inbox-status').textContent = 'Loading Outlook messages...';
    const response = await fetch(`${API_BASE}/outlook/inbox`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Outlook inbox could not be loaded.');
    renderEmailResults(result, 'outlook');
    document.getElementById('inbox-status').textContent = `${result.length} messages loaded from Outlook.`;
    showToast(`${result.length} Outlook messages loaded.`);
  } catch (error) {
    showToast(error.message);
    document.getElementById('response-title').textContent = 'Outlook inbox is unavailable.';
    document.getElementById('response-summary').textContent = error.message;
    document.getElementById('inbox-status').textContent = error.message;
    document.getElementById('inbox-list').innerHTML = `<p class="empty-state">${error.message}</p>`;
  }
}

async function loadInbox() {
  const integrations = await fetch(`${API_BASE}/integrations`).then(response => response.json()).catch(() => []);
  const google = integrations.find(integration => integration.provider === 'gmail');
  const microsoft = integrations.find(integration => integration.provider === 'outlook');
  if (google?.configured) {
    await loadGmailInbox();
    return;
  }
  if (microsoft?.configured) {
    await loadOutlookInbox();
    return;
  }
  const message = 'Connect Gmail or Outlook before loading your inbox.';
  document.getElementById('inbox-status').textContent = message;
  document.getElementById('inbox-list').innerHTML = `<p class="empty-state">${message}</p>`;
  showToast(message);
}

async function loadLiveData() {
  try {
    const [workflows, activity, integrations] = await Promise.all([
      fetch(`${API_BASE}/workflows`).then(response => response.json()),
      fetch(`${API_BASE}/activity`).then(response => response.json()),
      fetch(`${API_BASE}/integrations`).then(response => response.json())
    ]);
    state.workflows = workflows;
    state.activities = activity.map(item => ({ text: item.action, time: new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round((new Date(item.created_at) - Date.now()) / 60000), 'minute') }));
    renderWorkflows();
    renderActivity();
    renderIntegrations(integrations);
  } catch {
    showToast('The server is unavailable. Showing local controls only.');
  }
}

async function createWorkflow() {
  const name = window.prompt('Name this workflow');
  if (!name?.trim()) return;

  try {
    const response = await fetch(`${API_BASE}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    const workflow = await response.json();
    if (!response.ok) throw new Error(workflow.error || 'Workflow could not be created.');
    state.workflows.unshift(workflow);
    renderWorkflows();
    showToast('Workflow created and saved.');
  } catch (error) {
    showToast(error.message);
  }
}

function renderResponse() {
  const title = document.getElementById('response-title');
  const summary = document.getElementById('response-summary');
  title.textContent = state.response.title;
  summary.textContent = state.response.summary;
}

function renderChat() {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  list.replaceChildren();
  state.chat.slice(-8).forEach(message => {
    const item = document.createElement('div');
    item.className = `chat-message ${message.role}`;
    if (message.role === 'assistant') renderFormattedMessage(item, message.text);
    else item.textContent = message.text;
    list.appendChild(item);
  });
  list.scrollTop = list.scrollHeight;
}

function appendInlineFormatting(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > start) parent.appendChild(document.createTextNode(text.slice(start, match.index)));
    const token = match[0];
    let element;
    let content;
    if (token.startsWith('**') || token.startsWith('__')) {
      element = document.createElement('strong');
      content = token.slice(2, -2);
    } else if (token.startsWith('`')) {
      element = document.createElement('code');
      content = token.slice(1, -1);
    } else {
      element = document.createElement('em');
      content = token.slice(1, -1);
    }
    element.textContent = content;
    parent.appendChild(element);
    start = match.index + token.length;
  }
  if (start < text.length) parent.appendChild(document.createTextNode(text.slice(start)));
}

function renderFormattedMessage(container, text) {
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const node = document.createElement('p');
    appendInlineFormatting(node, paragraph.join(' '));
    container.appendChild(node);
    paragraph = [];
  };
  const flushList = () => {
    if (list) container.appendChild(list);
    list = null;
  };
  String(text || '').split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      return;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const node = document.createElement('h4');
      appendInlineFormatting(node, heading[1]);
      container.appendChild(node);
      return;
    }
    const unordered = line.match(/^[-*•]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = ordered ? 'ol' : 'ul';
      if (list && list.tagName.toLowerCase() !== nextType) flushList();
      if (!list) list = document.createElement(nextType);
      const item = document.createElement('li');
      appendInlineFormatting(item, (unordered || ordered)[1]);
      list.appendChild(item);
      return;
    }
    flushList();
    paragraph.push(line);
  });
  flushParagraph();
  flushList();
}

function clearConversation() {
  state.chat = [{ role: 'assistant', text: 'Conversation cleared. What would you like to work on?' }];
  state.awaitingNewsSkills = false;
  state.pendingNewsOpportunity = null;
  state.response.title = 'Your workspace is clear.';
  state.response.summary = 'Start a new conversation whenever you are ready.';
  saveState();
  renderChat();
  renderResponse();
}

function setChatTyping(isTyping) {
  const list = document.getElementById('chat-messages');
  const existing = list.querySelector('.typing-message');
  if (isTyping && !existing) {
    const item = document.createElement('div');
    item.className = 'chat-message assistant typing-message';
    item.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span><span>Thinking through this with you...</span>';
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
  } else if (!isTyping) {
    existing?.remove();
  }
}

function setChatBusy(busy) {
  isChatBusy = busy;
  document.getElementById('command-input').disabled = busy;
  document.getElementById('command-submit').disabled = busy;
  document.querySelector('.voice-button').disabled = busy;
  document.getElementById('command-bar').setAttribute('aria-busy', String(busy));
}

function populateSpeechVoices() {
  const select = document.getElementById('speech-voice-select');
  if (!select || !window.speechSynthesis) return;
  const englishVoices = window.speechSynthesis.getVoices()
    .filter(voice => /^en(-|$)/i.test(voice.lang))
    .sort((a, b) => Number(/natural|neural|enhanced|premium|online|samantha|jenny|aria/i.test(b.name)) - Number(/natural|neural|enhanced|premium|online|samantha|jenny|aria/i.test(a.name)));
  const selected = state.speechVoice;
  select.replaceChildren();
  const automatic = document.createElement('option');
  automatic.value = '';
  automatic.textContent = 'Automatic · most natural available';
  select.appendChild(automatic);
  englishVoices.forEach(voice => {
    const option = document.createElement('option');
    option.value = voice.voiceURI || `${voice.name}|${voice.lang}`;
    option.textContent = `${voice.name} (${voice.lang})`;
    select.appendChild(option);
  });
  select.value = englishVoices.some(voice => (voice.voiceURI || `${voice.name}|${voice.lang}`) === selected) ? selected : '';
}

function speakAssistantMessage(text) {
  const plainText = String(text || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/```[\s\S]*?```/g, match => match.replace(/```/g, ''))
    .replace(/[*_#>`]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const utterance = new SpeechSynthesisUtterance(plainText);
  const voices = window.speechSynthesis.getVoices();
  const englishVoices = voices.filter(voice => /^en(-|$)/i.test(voice.lang));
  const preferredVoice = englishVoices.find(voice => (voice.voiceURI || `${voice.name}|${voice.lang}`) === state.speechVoice)
    || englishVoices.find(voice => /natural|neural|enhanced|premium|online|samantha|jenny|aria/i.test(voice.name))
    || englishVoices.find(voice => /^en-US$/i.test(voice.lang))
    || englishVoices[0];

  if (preferredVoice) utterance.voice = preferredVoice;
  utterance.rate = 0.92;
  utterance.pitch = 1.02;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function updateSuggestions(inputValue) {
  const value = inputValue.trim().toLowerCase();
  const suggestionButtons = document.querySelectorAll('.suggestion');

  suggestionButtons.forEach(button => {
    const label = button.dataset.command.toLowerCase();
    const shouldShow = !value || label.includes(value);
    button.classList.toggle('is-hidden', !shouldShow);
  });
}

async function applyCommand(rawCommand) {
  const command = rawCommand.trim();
  if (!command || isChatBusy) return;

  const capturedNewsSkills = state.awaitingNewsSkills;
  const pendingNewsOpportunity = capturedNewsSkills ? state.pendingNewsOpportunity : null;
  if (capturedNewsSkills) {
    state.newsSkills = command.slice(0, 2000);
    state.awaitingNewsSkills = false;
    state.pendingNewsOpportunity = null;
    const skillsInput = document.getElementById('news-skills-input');
    if (skillsInput) skillsInput.value = state.newsSkills;
  }

  const input = document.getElementById('command-input');
  input.value = command;
  state.chat.push({ role: 'user', text: command });
  renderChat();
  saveState();

  const commandBar = document.getElementById('command-bar');
  commandBar.classList.add('processing');
  setChatBusy(true);
  setChatTyping(true);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 65000);
  try {
    const requestMessages = state.chat.map(message => ({ ...message }));
    if (capturedNewsSkills && pendingNewsOpportunity) {
      const lastUserIndex = requestMessages.findLastIndex(message => message.role === 'user');
      if (lastUserIndex >= 0) {
        requestMessages[lastUserIndex].text = `My skills and services are: ${state.newsSkills}. Now suggest one realistic, low-cost way to monetize this specific story. Story: ${pendingNewsOpportunity.title}. Summary: ${pendingNewsOpportunity.summary}. Source: ${pendingNewsOpportunity.source} (${pendingNewsOpportunity.url}). Name a likely customer, a clear offer using my skills, a first action, and a simple way to price or test it. Treat this as business research, not investment advice; do not recommend buying or selling assets or guarantee returns.`;
      }
    }
    const requestOptions = {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(sessionProviderKey ? { 'x-openrouter-api-key': sessionProviderKey } : {})
      },
      body: JSON.stringify({ messages: requestMessages, businessContext: state.newsSkills.slice(0, 2000) })
    };
    let response;
    let result;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await fetch(`${API_BASE}/chat`, requestOptions);
      result = await response.json();
      if (response.ok || result.error !== 'OpenRouter returned an empty response.') break;
    }
    if (!response.ok) throw new Error(result.error || 'The helper is unavailable.');
    state.response.title = 'Your helper says';
    state.response.summary = result.text;
    state.chat.push({ role: 'assistant', text: result.text });
    renderChat();
    setProviderAvailability(true);
    if (result.provider === 'groq') showToast('OpenRouter was unavailable; Groq answered instead.');
    renderResponse();
    if (state.voiceResponses && window.speechSynthesis) {
      speakAssistantMessage(result.text);
    }
    if (capturedNewsSkills) showToast('Skills saved. Monetization idea ready.');
  } catch (error) {
    setProviderAvailability(false);
    const message = error.name === 'AbortError'
      ? 'That reply took too long. OpenRouter may be busy; please try again in a moment.'
      : error.message;
    state.chat.push({ role: 'assistant', text: `I could not reach my conversation service. ${message}` });
    renderChat();
    showToast(message);
  } finally {
    window.clearTimeout(timeoutId);
    setChatTyping(false);
    setChatBusy(false);
    commandBar.classList.remove('processing');
    saveState();
  }
}

window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) {
    setDrawerOpen(false);
  }
  const isMetaK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
  if (isMetaK) {
    event.preventDefault();
    const input = document.getElementById('command-input');
    input.focus();
    input.select();
  }
});

function bindEvents() {
  const accentPicker = document.getElementById('accent-color-picker');

  accentPicker.addEventListener('input', event => {
    state.accent = event.target.value;
    applyAccent(state.accent);
    saveState();
  });

  document.querySelectorAll('.swatch').forEach(button => {
    button.addEventListener('click', () => {
      const accent = button.dataset.accent;
      state.accent = accent;
      applyAccent(state.accent);
      saveState();
    });
  });

  document.querySelectorAll('[data-policy]').forEach(select => {
    select.addEventListener('change', event => {
      const policy = event.currentTarget.dataset.policy;
      state.policies[policy] = event.currentTarget.value;
      saveState();
      const labels = {
        ask: 'I will ask before acting.',
        auto: 'Automatic action enabled.',
        never: 'This action is disabled.'
      };
      showToast(`${event.currentTarget.options[event.currentTarget.selectedIndex].text}: ${labels[event.currentTarget.value]}`);
    });
  });

  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', () => {
      setView(button.dataset.view);
      if (button.dataset.view === 'settings') {
        document.getElementById('autonomy-controls').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  document.querySelectorAll('.suggestion').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.action === 'open-inbox') {
        setView('inbox');
        return;
      }
      if (button.dataset.action === 'open-news') {
        setActiveTab('news');
        return;
      }
      const value = button.dataset.command || button.textContent;
      applyCommand(value);
    });
  });

  document.getElementById('clear-chat').addEventListener('click', clearConversation);

  document.getElementById('command-submit').addEventListener('click', () => {
    const input = document.getElementById('command-input');
    applyCommand(input.value);
  });

  document.getElementById('command-input').addEventListener('input', event => {
    updateSuggestions(event.target.value);
  });

  document.getElementById('command-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyCommand(event.currentTarget.value);
    }
  });

  document.getElementById('add-workflow').addEventListener('click', createWorkflow);

  document.querySelector('.workspace-button').addEventListener('click', () => {
    showToast('Personal OS is the active workspace.');
  });

  document.querySelector('.voice-button').addEventListener('click', () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast('Voice input is unavailable here. Type your skills in the message box instead.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.onstart = () => showToast('Listening...');
    recognition.onresult = event => {
      document.getElementById('command-input').value = event.results[0][0].transcript;
      applyCommand(event.results[0][0].transcript);
    };
    recognition.onerror = () => showToast('I could not hear that. Try typing instead.');
    recognition.start();
  });

  const outlookNotify = document.getElementById('outlook-notify');
  outlookNotify?.addEventListener('click', async () => {
    try {
      const response = await fetch(`${API_BASE}/notifications/outlook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'Business Agent notification',
          body: 'Your Business Agent has a new approved notification to review.'
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Outlook notification failed');
      showToast('Outlook email sent.');
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById('review-response').addEventListener('click', () => {
    document.getElementById('response-summary').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('This is the current response from live app state.');
  });

  document.getElementById('see-all-workflows').addEventListener('click', () => {
    document.getElementById('workflow-list').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast(`${state.workflows.length} workflow${state.workflows.length === 1 ? '' : 's'} loaded from the server.`);
  });

  document.getElementById('manage-integrations').addEventListener('click', () => {
    document.getElementById('integration-list').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('Integration status is loaded from the server.');
  });

  document.getElementById('integration-list').addEventListener('click', event => {
    if (event.target.id === 'outlook-inbox') loadOutlookInbox();
    if (event.target.id === 'gmail-connect') {
      window.location.href = `${API_BASE.replace(/\/api$/, '')}/auth/google/start`;
    }
  });

  document.getElementById('load-inbox').addEventListener('click', loadInbox);
  const newsSkillsInput = document.getElementById('news-skills-input');
  newsSkillsInput.value = state.newsSkills || '';
  document.getElementById('save-news-skills').addEventListener('click', () => {
    state.newsSkills = newsSkillsInput.value.trim().slice(0, 2000);
    newsSkillsInput.value = state.newsSkills;
    saveState();
    showToast('Your skills are saved for monetization ideas.');
  });
  const newsCategoryFilter = document.getElementById('news-category-filter');
  newsCategoryFilter.value = state.newsCategory || 'all';
  newsCategoryFilter.addEventListener('change', () => {
    state.newsCategory = newsCategoryFilter.value;
    saveState();
    renderNews();
  });
  document.getElementById('refresh-news').addEventListener('click', () => loadNews(true));
  document.getElementById('refresh-content').addEventListener('click', loadContent);
  document.getElementById('draft-content').addEventListener('click', () => submitContentPost('draft'));
  document.getElementById('schedule-content').addEventListener('click', () => submitContentPost('schedule'));
  document.getElementById('generate-content-draft').addEventListener('click', generateContentDraft);
  document.getElementById('save-telegram-reply-settings').addEventListener('click', async () => {
    const toggle = document.getElementById('telegram-auto-reply');
    if (toggle.checked && !window.confirm('Automatically reply to Telegram messages that are replies to your bot posts?')) return;
    const response = await fetch(`${API_BASE}/content/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telegramAutoReply: toggle.checked, telegramAutoReplyTemplate: document.getElementById('telegram-reply-template').value })
    });
    const result = await response.json();
    if (!response.ok) {
      toggle.checked = false;
      showToast(result.error || 'Reply settings could not be saved.');
      return;
    }
    showToast(toggle.checked ? 'Telegram auto-replies enabled.' : 'Telegram auto-replies paused.');
    await loadContent();
  });
  const autoReplyToggle = document.getElementById('auto-reply-high-priority');
  const autoReplyTemplate = document.getElementById('high-priority-reply-template');
  autoReplyToggle.checked = Boolean(state.autoReplyHighPriority);
  autoReplyTemplate.value = state.highPriorityReplyTemplate;
  autoReplyToggle.addEventListener('change', () => {
    if (autoReplyToggle.checked && !window.confirm('Automatically send this acknowledgment once to each email you mark High?')) {
      autoReplyToggle.checked = false;
      return;
    }
    state.autoReplyHighPriority = autoReplyToggle.checked;
    saveState();
    if (state.autoReplyHighPriority) processHighPriorityAutoReplies(inboxMessages);
    showToast(state.autoReplyHighPriority ? 'High-priority auto-replies enabled.' : 'High-priority auto-replies paused.');
  });
  autoReplyTemplate.addEventListener('input', () => {
    state.highPriorityReplyTemplate = autoReplyTemplate.value;
    saveState();
  });
  const priorityFilter = document.getElementById('inbox-priority-filter');
  priorityFilter.value = state.inboxPriorityFilter || 'all';
  priorityFilter.addEventListener('change', () => {
    state.inboxPriorityFilter = priorityFilter.value;
    saveState();
    renderEmailResults(inboxMessages, inboxProvider);
  });

  document.getElementById('advance-opportunity').addEventListener('click', async event => {
    if (!state.workflows.length) {
      showToast('Create a workflow or connect a business source first.');
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Requesting approval...';
    try {
      const response = await fetch(`${API_BASE}/approvals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'Draft follow-up', details: { workflow_id: state.workflows[0].id, next_action: state.workflows[0].next_action || state.workflows[0].next } })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Approval request could not be created.');
      state.response.title = 'Follow-up approval requested.';
      state.response.summary = `Approval ${result.id} is pending. Nothing will be sent until you approve it.`;
      renderResponse();
      showToast('Approval request created.');
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
      button.innerHTML = 'Draft follow-up <span aria-hidden="true">→</span>';
    }
  });

  document.getElementById('theme-toggle').addEventListener('click', () => {
    state.dark = !state.dark;
    document.body.classList.toggle('dark', state.dark);
    document.getElementById('theme-toggle').textContent = state.dark ? '☀' : '☾';
    saveState();
  });

  document.querySelectorAll('.bottom-tab').forEach(button => {
    button.addEventListener('click', () => setActiveTab(button.dataset.tab));
  });

  document.getElementById('drawer-open').addEventListener('click', () => setDrawerOpen(true));
  document.getElementById('drawer-close').addEventListener('click', () => setDrawerOpen(false));
  document.getElementById('drawer-backdrop').addEventListener('click', () => setDrawerOpen(false));
  document.getElementById('open-content-settings').addEventListener('click', () => {
    setDrawerOpen(false);
    setActiveTab('content');
  });

  document.querySelectorAll('[data-hook]').forEach(toggle => {
    toggle.checked = Boolean(state.hooks[toggle.dataset.hook]);
    toggle.addEventListener('change', () => {
      state.hooks[toggle.dataset.hook] = toggle.checked;
      saveState();
      if (toggle.dataset.hook === 'google' && toggle.checked) {
        window.location.href = `${API_BASE.replace(/\/api$/, '')}/auth/google/start`;
        return;
      }
      showToast(`${toggle.closest('.integration-toggle').querySelector('strong').textContent} hook ${toggle.checked ? 'enabled' : 'paused'}.`);
    });
  });

  document.getElementById('save-provider-key').addEventListener('click', () => {
    sessionProviderKey = document.getElementById('provider-key').value.trim();
    showToast(sessionProviderKey ? 'Key held in memory for this session.' : 'Enter a key to use it in this session.');
    document.getElementById('provider-key').value = '';
  });

  const speechVoiceSelect = document.getElementById('speech-voice-select');
  populateSpeechVoices();
  if (window.speechSynthesis) window.speechSynthesis.addEventListener('voiceschanged', populateSpeechVoices);
  speechVoiceSelect.addEventListener('change', () => {
    state.speechVoice = speechVoiceSelect.value;
    saveState();
  });
  document.getElementById('preview-speech-voice').addEventListener('click', () => {
    if (!window.speechSynthesis) {
      showToast('Spoken replies are not supported in this browser.');
      return;
    }
    speakAssistantMessage('Hi, I’m here. Tell me what you’re working on, and we’ll figure out a useful next step together.');
  });

  document.getElementById('speech-toggle').addEventListener('click', event => {
    state.voiceResponses = !state.voiceResponses;
    event.currentTarget.setAttribute('aria-pressed', String(state.voiceResponses));
    saveState();
    showToast(state.voiceResponses ? 'Voice responses enabled.' : 'Voice responses muted.');
  });

  document.getElementById('invite-button').addEventListener('click', async () => {
    const inviteUrl = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: 'Nexus / Fuse', url: inviteUrl });
      else {
        await navigator.clipboard.writeText(inviteUrl);
        showToast('Workspace link copied.');
      }
    } catch (error) {
      if (error.name !== 'AbortError') showToast('Could not share the workspace link.');
    }
  });

  document.getElementById('generate-idea').addEventListener('click', generateIdea);
  document.getElementById('ideas-list').addEventListener('click', event => {
    const button = event.target.closest('.idea-use');
    if (!button) return;
    setActiveTab('chat');
    applyCommand(button.dataset.idea);
  });

  document.getElementById('attach-button').addEventListener('click', () => document.getElementById('context-file').click());
  document.getElementById('context-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 20000) {
      showToast('That text file is larger than the 20 KB context limit.');
      event.target.value = '';
      return;
    }
    const context = await file.text();
    const input = document.getElementById('command-input');
    input.value = `${input.value}${input.value ? '\n\n' : ''}Attached context (${file.name}):\n${context}`;
    input.focus();
    event.target.value = '';
    showToast(`${file.name} added as prompt context.`);
  });
}

function init() {
  document.body.classList.toggle('dark', state.dark);
  document.getElementById('theme-toggle').textContent = state.dark ? '☀' : '☾';
  applyAccent(state.accent || DEFAULT_ACCENT);
  document.getElementById('today-label').textContent = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date()).toUpperCase();

  renderWorkflows();
  renderActivity();
  renderResponse();
  renderChat();
  applyPolicies();
  const preferences = document.getElementById('drawer-preferences');
  document.getElementById('theme-toggle').textContent = state.dark ? '☀' : '☾';
  preferences.append(document.getElementById('theme-toggle'), document.querySelector('.color-picker-wrap'));
  document.getElementById('speech-toggle').setAttribute('aria-pressed', String(Boolean(state.voiceResponses)));
  updateSuggestions('');
  bindEvents();
  setActiveTab('chat');
  loadLiveData();
}

init();
