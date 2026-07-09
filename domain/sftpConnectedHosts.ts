import type { Host, TerminalSession } from "./models";

export type SftpConnectedHostEntry = {
  host: Host;
  sessionId: string;
  status: Extract<TerminalSession["status"], "connecting" | "connected">;
};

/** Fields the SFTP Connected picker cares about from a terminal session. */
export type SftpPickerSessionFields = Pick<
  TerminalSession,
  "id" | "hostId" | "protocol" | "status"
>;

const isSftpEligibleSession = (session: SftpPickerSessionFields): boolean => {
  if (session.status !== "connected" && session.status !== "connecting") return false;
  const protocol = session.protocol;
  if (protocol === "serial" || protocol === "local" || protocol === "telnet") return false;
  // Missing protocol defaults to SSH (same as host picker filtering).
  return true;
};

/**
 * Compare only picker-relevant session fields so title/cwd/font churn does not
 * invalidate side-panel memoization.
 */
export const sftpPickerSessionsEqual = (
  prev: ReadonlyArray<SftpPickerSessionFields> | null | undefined,
  next: ReadonlyArray<SftpPickerSessionFields> | null | undefined,
): boolean => {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;

  const nextById = new Map(next.map((session) => [session.id, session]));
  if (nextById.size !== next.length) return false;

  for (const session of prev) {
    const other = nextById.get(session.id);
    if (!other) return false;
    if (
      session.hostId !== other.hostId
      || session.protocol !== other.protocol
      || session.status !== other.status
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Build the "currently connected" host list for the SFTP host picker.
 * One entry per hostId — prefers a connected session over connecting,
 * then the most recently listed session for that host.
 */
export const listSftpConnectedHosts = (
  sessions: ReadonlyArray<SftpPickerSessionFields>,
  hostsById: ReadonlyMap<string, Host>,
): SftpConnectedHostEntry[] => {
  const bestByHostId = new Map<string, SftpConnectedHostEntry>();

  for (const session of sessions) {
    if (!isSftpEligibleSession(session)) continue;
    const host = hostsById.get(session.hostId);
    if (!host) continue;
    if (host.protocol === "serial") continue;

    const next: SftpConnectedHostEntry = {
      host,
      sessionId: session.id,
      status: session.status === "connecting" ? "connecting" : "connected",
    };
    const existing = bestByHostId.get(host.id);
    if (!existing) {
      bestByHostId.set(host.id, next);
      continue;
    }
    // Prefer connected over connecting; otherwise keep the first seen.
    if (existing.status === "connecting" && next.status === "connected") {
      bestByHostId.set(host.id, next);
    }
  }

  return [...bestByHostId.values()].sort((a, b) =>
    a.host.label.localeCompare(b.host.label),
  );
};
