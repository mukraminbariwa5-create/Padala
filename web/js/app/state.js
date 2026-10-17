// Shared state: the API client, the signed-in person, teams, projects, and project status names.
import { createApi } from '../api.js';

export const api = createApi();
export const app = document.getElementById('app');
export const STATUS = { building: 'Building', sent: 'Sent', handed_over: 'Given to client', paid: 'Paid' };
export const STATUS_HELP = { building: 'Still working on it', sent: 'Files sent to the team', handed_over: 'The client has it', paid: 'Done and paid' };
export const STATUS_ORDER = ['building', 'sent', 'handed_over', 'paid'];

export const S = {
  me: null, teams: [], team: null, keys: null, keyMissing: false,
  projects: [], online: new Set(), projectData: new Map(), texts: new Map(),
  events: null, live: false, busy: null, drafts: {}, replyTo: {}, announced: new Set(), teamUnread: {}, nudged: new Set(), versions: new Map(), enter: true, publicUrl: null, backupKey: null, backupOn: false, keySalt: null, hasRecovery: true, connectedOnce: false, sideFilter: '', projFilter: 'all', projQuery: '',
};

// Files the person chose to leave out of a project stay left out next time (per device).
const LEFT_OUT = 'padala.leftOut';
export const leftOutFor = (projectId) => { try { return JSON.parse(localStorage.getItem(LEFT_OUT) || '{}')[projectId] || []; } catch { return []; } };
export const saveLeftOut = (projectId, paths) => {
  try {
    const all = JSON.parse(localStorage.getItem(LEFT_OUT) || '{}');
    if (paths.length) all[projectId] = paths; else delete all[projectId];
    localStorage.setItem(LEFT_OUT, JSON.stringify(all));
  } catch { /* storage off: just ask again next time */ }
};
