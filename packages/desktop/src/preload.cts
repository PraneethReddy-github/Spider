import { contextBridge, ipcRenderer } from 'electron';

/** What the web app may ask of the desktop shell (nothing else crosses the bridge). */
contextBridge.exposeInMainWorld('spiderDesktop', {
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke('spider:pick-folder'),
});
