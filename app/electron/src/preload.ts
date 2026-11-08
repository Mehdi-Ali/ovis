import { contextBridge, ipcRenderer } from "electron";

// only the app's own connection screen gets the bridge, never a page the server serves
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("ovisDesktop", {
    status: () => ipcRenderer.invoke("ovis:status"),
    onStatus: (listener: (status: unknown) => void) => {
      ipcRenderer.on("ovis:status", (_event, status: unknown) => listener(status));
    },
    retry: () => ipcRenderer.send("ovis:retry"),
    showLogs: () => ipcRenderer.send("ovis:logs"),
  });
} else {
  // the app's own update, offered in Settings' header (src/lib/headerUpdate.ts); main answers only its own server's pages
  contextBridge.exposeInMainWorld("ovisUpdates", {
    state: (): Promise<unknown> => ipcRenderer.invoke("ovis:update"),
    onState: (listener: (state: unknown) => void) => {
      const forward = (_event: unknown, state: unknown) => listener(state);
      ipcRenderer.on("ovis:update", forward);
      return () => { ipcRenderer.removeListener("ovis:update", forward); };
    },
    act: () => ipcRenderer.send("ovis:update-action"),
  });
  // the server's pages sign in to the account through the system browser (src/accountSignIn.ts);
  // main answers only its own server's pages, and only while an account service is named
  const named = ipcRenderer.sendSync("ovis:account-service") as { service?: unknown; providers?: unknown } | null;
  if (typeof named?.service === "string") {
    contextBridge.exposeInMainWorld("ovisAccount", {
      service: named.service,
      providers: Array.isArray(named.providers) ? named.providers.filter((name): name is string => typeof name === "string") : [],
      start: (): Promise<string> => ipcRenderer.invoke("ovis:account-start"),
      open: (url: string): Promise<string> => ipcRenderer.invoke("ovis:account-open", url),
    });
  }
}
