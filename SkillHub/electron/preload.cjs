const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then(result => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
});
contextBridge.exposeInMainWorld('skillHub', Object.freeze({
  getState: () => invoke('skills:state'),
  importSkill: () => invoke('skills:import'),
  discoverSkills: () => invoke('skills:discover'),
  importDiscovered: ids => invoke('skills:import-discovered', ids),
  detectTargets: () => invoke('install:targets'),
  planInstallation: input => invoke('install:plan', input),
  applyInstallation: id => invoke('install:apply', id),
  previewRepository: input => invoke('repo:preview', input),
  previewLocalRepository: () => invoke('repo:local'),
  importRepository: input => invoke('repo:import', input),
  exportMigration: () => invoke('migration:export'),
  previewMigration: () => invoke('migration:preview'),
  restoreMigration: input => invoke('migration:restore', input),
  pendingMigration: () => invoke('migration:pending'),
  saveSkill: input => invoke('skills:save', input),
  deleteSkill: id => invoke('skills:delete', id),
  saveProfile: input => invoke('profiles:save', input),
  deleteProfile: id => invoke('profiles:delete', id),
  exportProfile: id => invoke('profiles:export', id),
  openDataFolder: () => invoke('app:open-data')
}));
