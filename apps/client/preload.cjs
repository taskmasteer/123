const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('factoryDesktop',{
 importConnection:()=>ipcRenderer.invoke('factory:import-connection'),
 version:ipcRenderer.sendSync('factory:version'),
 updateDownload:()=>ipcRenderer.invoke('factory:update-download'),
 endpoint:ipcRenderer.sendSync('factory:connection'),
 request:(path,method,body,csrf)=>ipcRenderer.invoke('factory:request',{path,method,body,csrf}),
 backupDownload:id=>ipcRenderer.invoke('factory:backup-download',id),
 clearSession:()=>ipcRenderer.invoke('factory:clear-session'),
 saveAccess:text=>ipcRenderer.invoke('factory:save-access',text),
 download:(siteId,revisionId,path)=>ipcRenderer.invoke('factory:download',{siteId,revisionId,path}),
 external:url=>ipcRenderer.invoke('factory:external',url),
 preview:url=>ipcRenderer.invoke('factory:preview',url)
 ,copyKey:code=>ipcRenderer.invoke('factory:copy-key',code)
});
