const STORAGE_KEY = 'central-orchestrator-state-v1';
const API_BASE = 'http://localhost:8787/api';
const initialState = {
  workflows: [
    { id: 'meeting-prep', name: 'Client discovery preparation', completed: 2, total: 5, status: 'Active', next: 'Review meeting purpose' },
    { id: 'grant-research', name: 'Grant research', completed: 6, total: 10, status: 'Paused', next: 'Compare eligibility requirements' },
    { id: 'proposal', name: 'Revised proposal', completed: 3, total: 7, status: 'Waiting', next: 'Review requested changes' }
  ],
  activities: [
    { text: 'Checkpoint saved', time: '2m ago' },
    { text: 'Briefing refreshed', time: '8m ago' },
    { text: 'Waiting state reviewed', time: 'Yesterday' }
  ],
  nextActionStarted: false,
  dark: false
};
let state = loadState();
let backendAvailable = false;

function loadState() {
  try { return { ...initialState, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; }
  catch { return initialState; }
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
async function syncFromBackend() {
  try {
    const [workflowsResponse, activityResponse] = await Promise.all([fetch(`${API_BASE}/workflows`), fetch(`${API_BASE}/activity`)]);
    if (!workflowsResponse.ok || !activityResponse.ok) return;
    const workflows = await workflowsResponse.json();
    const activities = await activityResponse.json();
    backendAvailable = true;
    if (workflows.length) {
      state.workflows = workflows.map(workflow => ({ id: workflow.id, name: workflow.name, completed: workflow.current_step_number, total: workflow.total_steps, status: workflow.status[0].toUpperCase() + workflow.status.slice(1), next: workflow.next_action }));
      renderWorkflows();
    }
    if (activities.length) {
      state.activities = activities.slice(0, 4).map(activity => ({ text: activity.action, time: new Date(activity.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }));
      renderActivity();
    }
  } catch { backendAvailable = false; }
}
async function backendTransition(status, reason = '') {
  const active = state.workflows.find(workflow => workflow.id === 'meeting-prep') || state.workflows[0];
  if (!backendAvailable || !active || !active.id.includes('-')) return;
  await fetch(`${API_BASE}/workflows/${active.id}/transition`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, reason }) });
}
function showToast(message) { const toast = document.getElementById('toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2600); }
function logActivity(text) { state.activities.unshift({ text, time: 'Just now' }); state.activities = state.activities.slice(0, 4); saveState(); renderActivity(); }
function renderActivity() { document.getElementById('activity-list').innerHTML = state.activities.slice(0, 3).map(item => `<span class="activity-event"><b></b>${item.text} <small>${item.time}</small></span>`).join(''); }
function renderWorkflows() {
  document.getElementById('workflow-list').innerHTML = state.workflows.map(workflow => {
    const percentage = Math.round((workflow.completed / workflow.total) * 100);
    const statusIcon = workflow.status === 'Paused' ? 'Ⅱ' : workflow.status === 'Waiting' ? '…' : '→';
    return `<div class="workflow-row"><span class="workflow-status">${statusIcon}</span><div class="workflow-info"><strong>${workflow.name}</strong><small>${workflow.status} · ${workflow.next}</small></div><div class="workflow-progress"><span>${workflow.completed}/${workflow.total}</span><div class="mini-progress"><i style="width:${percentage}%"></i></div></div></div>`;
  }).join('');
}
function setView(view) {
  const names = { command: 'Overview', inbox: 'Inbox', calendar: 'Calendar', meetings: 'Meetings', tasks: 'Tasks', business: 'Businesses', opportunities: 'Opportunities', checkpoints: 'Checkpoints', settings: 'Settings', activity: 'Activity' };
  const title = names[view] || 'Overview';
  document.getElementById('page-title').textContent = title;
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  if (view !== 'command') showToast(`${title} is ready for the next connected data source.`);
}
function runCommand(command) {
  const normalized = command.toLowerCase();
  if (normalized.includes('pause')) { setView('checkpoints'); showToast('Showing your paused workflows.'); return; }
  if (normalized.includes('today')) { setView('calendar'); showToast('Your day is already visible in the briefing.'); return; }
  if (normalized.includes('waiting')) { setView('tasks'); showToast('Two follow-ups are waiting for a response.'); return; }
  showToast('I can prepare that once an information source is connected.');
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelectorAll('[data-view-link]').forEach(button => button.addEventListener('click', () => setView(button.dataset.viewLink)));
document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => { document.getElementById('command-input').value = button.dataset.command; runCommand(button.dataset.command); }));
document.getElementById('command-submit').addEventListener('click', () => { const input = document.getElementById('command-input'); if (input.value.trim()) runCommand(input.value.trim()); });
document.getElementById('command-input').addEventListener('keydown', event => { if (event.key === 'Enter' && event.currentTarget.value.trim()) runCommand(event.currentTarget.value.trim()); });
document.getElementById('start-action').addEventListener('click', async () => { state.nextActionStarted = true; document.getElementById('start-action').innerHTML = 'Step in progress <span>✓</span>'; document.getElementById('next-progress').style.width = '52%'; await backendTransition('active'); logActivity('Workflow step started'); showToast('Checkpoint updated. Your step is in progress.'); });
document.getElementById('pause-action').addEventListener('click', async event => { event.currentTarget.textContent = 'Paused'; event.currentTarget.disabled = true; await backendTransition('paused', 'User paused the current step'); logActivity('Workflow paused by user'); showToast('Paused with checkpoint saved.'); });
document.getElementById('add-workflow').addEventListener('click', async () => { const name = prompt('Name this workflow'); if (!name || !name.trim()) return; if (backendAvailable) { await fetch(`${API_BASE}/workflows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); await syncFromBackend(); } else { state.workflows.push({ id: Date.now().toString(), name: name.trim(), completed: 0, total: 1, status: 'Active', next: 'Define the smallest next step' }); saveState(); renderWorkflows(); } logActivity(`Workflow created: ${name.trim()}`); showToast('Workflow created with a starting checkpoint.'); });
document.getElementById('theme-toggle').addEventListener('click', () => { state.dark = !state.dark; document.body.classList.toggle('dark', state.dark); saveState(); });

document.getElementById('today-label').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()).toUpperCase();
document.body.classList.toggle('dark', state.dark); renderWorkflows(); renderActivity();
syncFromBackend();
