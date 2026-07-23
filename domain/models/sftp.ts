// SFTP Types
export type SftpFilenameEncoding = 'auto' | 'utf-8' | 'gb18030';

export interface SftpFileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  sizeFormatted: string;
  lastModified: number;
  lastModifiedFormatted: string;
  permissions?: string;
  owner?: string;
  group?: string;
  linkTarget?: 'file' | 'directory' | null; // For symlinks: the type of the target, or null if broken
  hidden?: boolean; // Windows hidden attribute (only set for local Windows filesystem)
}

export interface SftpConnection {
  id: string;
  hostId: string;
  hostLabel: string;
  isLocal: boolean;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error?: string;
  currentPath: string;
  homeDir?: string;
  /** True when this SFTP connection reuses an existing terminal SSH session */
  reusedConnection?: boolean;
  fileProtocol?: 'auto' | 'sftp' | 'scp';
}

export type TransferStatus =
  | 'pending'
  | 'queued'
  | 'transferring'
  | 'pausing'
  | 'paused'
  | 'attention'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type TransferDirection = 'upload' | 'download' | 'remote-to-remote' | 'local-copy';
export type TransferOrigin = 'manual' | 'drag-drop' | 'editor-sync' | 'agent' | 'internal';
export type TransferPhase = 'scanning' | 'compressing' | 'uploading' | 'transferring' | 'extracting' | 'verifying';

export interface TransferTask {
  id: string;
  batchId?: string;
  fileName: string;
  originalFileName?: string;
  sourcePath: string;
  targetPath: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  targetHostId?: string;
  /** Full endpoint key (hostId:hostname:port:protocol) for distinguishing
   * same-hostId uploads with different session-time overrides. */
  targetConnectionKey?: string;
  direction: TransferDirection;
  status: TransferStatus;
  totalBytes: number;
  transferredBytes: number;
  speed: number; // bytes per second
  error?: string;
  startTime: number;
  endTime?: number;
  isDirectory: boolean;
  progressMode?: 'bytes' | 'files';
  childTasks?: string[]; // For directory transfers
  parentTaskId?: string;
  sourceLastModified?: number; // Cached from file list to avoid redundant stat
  skipConflictCheck?: boolean; // Skip conflict check for replace operations
  replaceExistingTarget?: boolean; // Delete the existing target before transferring
  retryable?: boolean; // False for task types that cannot be safely replayed through generic retry
  ownerId?: string;
  sourceHostId?: string;
  sourceHostLabel?: string;
  targetHostLabel?: string;
  origin?: TransferOrigin;
  background?: boolean;
  phase?: TransferPhase;
  resumable?: boolean;
  checkpointBytes?: number;
  resumeStage?: 'direct' | 'download' | 'upload';
  downloadCheckpointBytes?: number;
  uploadCheckpointBytes?: number;
  priority?: number;
  updatedAt?: number;
  pauseUnavailableReason?: string;
  conflict?: FileConflict;
  stagedTargetPath?: string;
  sourceFingerprint?: string;
  reconnectRequired?: boolean;
}

export type FileConflictAction = 'stop' | 'skip' | 'replace' | 'duplicate' | 'merge';

export interface FileConflict {
  transferId: string;
  batchId?: string;
  fileName: string;
  sourcePath: string;
  targetPath: string;
  isDirectory: boolean;
  existingType?: 'file' | 'directory' | 'symlink';
  applyToAllCount?: number;
  existingSize: number;
  newSize: number;
  existingModified: number;
  newModified: number;
}
