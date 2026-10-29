const KEY = 'skill-hub-browser-preview-v1';
const providers = ['Codex', 'Claude', 'Gemini', 'ChatGPT'];

function initialState() {
  return {
    version: 1,
    skills: [],
    profiles: providers.map((provider) => ({ id: provider.toLowerCase(), name: provider, provider, skillIds: [] })),
    dataPath: 'ข้อมูลตัวอย่างในเบราว์เซอร์นี้',
  };
}

function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return initialState();
  const state = JSON.parse(raw);
  if (state.version !== 1 || !Array.isArray(state.skills) || !Array.isArray(state.profiles)) {
    throw new Error('ข้อมูลตัวอย่างไม่ถูกต้อง กรุณาล้างข้อมูลเว็บไซต์นี้แล้วเปิดใหม่');
  }
  return state;
}

function write(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
  return structuredClone(state);
}

const unavailable = async () => {
  throw new Error('ฟังก์ชันโฟลเดอร์ใช้ได้ในแอป Windows กรุณาเปิด Skill Hub บนเดสก์ท็อป');
};

export const isBrowserPreview = !window.skillHub;

export const api = window.skillHub || {
  getState: async () => load(),
  importSkill: unavailable,
  discoverSkills: async () => ({ items: [], roots: [], warnings: ['ค้นหา Skill บนเครื่องได้ในแอป Windows'] }),
  importDiscovered: unavailable,
  openDataFolder: unavailable,
  exportProfile: unavailable,
  previewRepository: unavailable,
  previewLocalRepository: unavailable,
  importRepository: unavailable,
  detectTargets: unavailable,
  planInstallation: unavailable,
  applyInstallation: unavailable,
  exportMigration: unavailable,
  previewMigration: unavailable,
  restoreMigration: unavailable,
  pendingMigration: unavailable,
  saveSkill: async (input) => {
    const state = load();
    const id = input.id || crypto.randomUUID();
    const existing = state.skills.find((skill) => skill.id === id);
    if (input.id && !existing) throw new Error('ไม่พบ Skill นี้');
    if (!input.name.trim() || !input.content.trim()) throw new Error('กรุณาระบุชื่อและคำสั่งของ Skill');
    const skill = { ...input, id, source: existing?.source || 'created', fileCount: existing?.fileCount || 1, updatedAt: new Date().toISOString() };
    state.skills = existing ? state.skills.map((item) => item.id === id ? skill : item) : [...state.skills, skill];
    return write(state);
  },
  deleteSkill: async (id) => {
    const state = load();
    state.skills = state.skills.filter((skill) => skill.id !== id);
    state.profiles = state.profiles.map((profile) => ({ ...profile, skillIds: profile.skillIds.filter((skillId) => skillId !== id) }));
    return write(state);
  },
  saveProfile: async (input) => {
    const state = load();
    const id = input.id || crypto.randomUUID();
    if (!input.name.trim() || !input.provider.trim()) throw new Error('กรุณาระบุชื่อและระบบ AI');
    const profile = { ...input, id, skillIds: input.skillIds.filter((skillId) => state.skills.some((skill) => skill.id === skillId)) };
    state.profiles = state.profiles.some((item) => item.id === id)
      ? state.profiles.map((item) => item.id === id ? profile : item)
      : [...state.profiles, profile];
    return write(state);
  },
  deleteProfile: async (id) => {
    const state = load();
    state.profiles = state.profiles.filter((profile) => profile.id !== id);
    return write(state);
  },
};
