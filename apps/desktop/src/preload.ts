import { contextBridge, ipcRenderer } from 'electron';

// The page gets the local connection and nothing else from Node.
contextBridge.exposeInMainWorld('mobDesktop', {
	connection: () => ipcRenderer.invoke('mob:connection'),
});
