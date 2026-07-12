import type { Host, Identity } from "./models";
import type { QuickConnectTarget } from "./quickConnect";

export type QuickConnectProtocol = "ssh" | "mosh" | "et" | "telnet";

export const getQuickConnectDefaultPort = (
  protocol: QuickConnectProtocol,
): number => protocol === "telnet" ? 23 : 22;

export const buildQuickConnectHost = (args: {
  target: QuickConnectTarget;
  protocol: QuickConnectProtocol;
  port: number;
  username: string;
  authMethod: "password" | "key" | "certificate";
  password?: string;
  selectedKeyId?: string | null;
  selectedIdentity?: Identity;
  save: boolean;
  now?: number;
  randomId?: string;
}): Host => {
  const {
    target,
    protocol,
    selectedIdentity,
    save,
    now = Date.now(),
    randomId = Math.random().toString(36).slice(2, 11),
  } = args;
  const effectiveUsername = selectedIdentity?.username || args.username || target.username || "root";
  const authMethod = selectedIdentity?.authMethod || args.authMethod;
  const effectivePort = args.port || getQuickConnectDefaultPort(protocol);

  return {
    id: `quick-${now}-${randomId}`,
    label: target.hostname,
    hostname: target.hostname,
    port: effectivePort,
    username: effectiveUsername,
    group: "",
    tags: [],
    os: "linux",
    protocol: protocol === "mosh" || protocol === "et" ? "ssh" : protocol,
    authMethod,
    identityId: selectedIdentity?.id,
    password: !selectedIdentity && authMethod === "password" ? args.password : undefined,
    identityFileId:
      !selectedIdentity && (authMethod === "key" || authMethod === "certificate")
        ? args.selectedKeyId || undefined
        : undefined,
    moshEnabled: protocol === "mosh",
    etEnabled: protocol === "et",
    etPort: protocol === "et" ? 2022 : undefined,
    telnetEnabled: protocol === "telnet",
    telnetPort: protocol === "telnet" ? effectivePort : undefined,
    ephemeral: !save,
    createdAt: now,
  };
};
