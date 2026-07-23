import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

const requireBridge = () => {
  const bridge = netcattyBridge.get();
  if (!bridge) throw new Error("Netcatty desktop bridge is unavailable");
  return bridge;
};

export const pluginExtensionBridge = Object.freeze({
  async listProviders(kind: "connection" | "authentication" | "importer") {
    return requireBridge().listPluginExtensionProviders?.({ kind }) ?? [];
  },
  async updateCredentialCatalog(entries: ReadonlyArray<{ id: string; ciphertext: string }>) {
    return requireBridge().updatePluginCredentialCatalog?.(entries) ?? 0;
  },
  async detectImporter(request: Parameters<NonNullable<NetcattyBridge["detectPluginImporter"]>>[0]) {
    const bridge = requireBridge();
    if (!bridge.detectPluginImporter) return null;
    return bridge.detectPluginImporter(request);
  },
  async parseImporterFile(request: Parameters<NonNullable<NetcattyBridge["parsePluginImporterFile"]>>[0]) {
    const bridge = requireBridge();
    if (!bridge.parsePluginImporterFile) throw new Error("Plugin importer bridge is unavailable");
    return bridge.parsePluginImporterFile(request);
  },
  async selectImporterFile() {
    const bridge = requireBridge();
    if (!bridge.selectPluginImporterFile) throw new Error("Plugin importer file selection is unavailable");
    return bridge.selectPluginImporterFile();
  },
  async releaseImporterFile(selectionToken: string) {
    return requireBridge().releasePluginImporterFile?.(selectionToken) ?? false;
  },
  onImporterProgress(listener: Parameters<NonNullable<NetcattyBridge["onPluginImporterProgress"]>>[0]) {
    return requireBridge().onPluginImporterProgress?.(listener);
  },
  onAuthenticationChallenge(listener: Parameters<NonNullable<NetcattyBridge["onPluginAuthenticationChallenge"]>>[0]) {
    return requireBridge().onPluginAuthenticationChallenge?.(listener);
  },
  async respondAuthenticationChallenge(
    response: Parameters<NonNullable<NetcattyBridge["respondPluginAuthenticationChallenge"]>>[0],
  ) {
    const bridge = requireBridge();
    if (!bridge.respondPluginAuthenticationChallenge) throw new Error("Plugin authentication bridge is unavailable");
    return bridge.respondPluginAuthenticationChallenge(response);
  },
  async openExternal(url: string) {
    return requireBridge().openExternal?.(url);
  },
});
