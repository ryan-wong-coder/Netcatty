import type { RemoteFile, SftpFilenameEncoding, TransferDirection } from "../../types";

declare global {
  interface NetcattyBridge {
    // SFTP operations
    openSftp(options: NetcattySSHOptions): Promise<string>;
    openSftpForSession?(sessionId: string): Promise<string>;
    listSftp(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<RemoteFile[]>;
    readSftp(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<string>;
    readSftpBinary?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<ArrayBuffer>;
    writeSftp(sftpId: string, path: string, content: string, encoding?: SftpFilenameEncoding): Promise<void>;
    writeSftpBinary?(sftpId: string, path: string, content: ArrayBuffer, encoding?: SftpFilenameEncoding): Promise<void>;
    closeSftp(sftpId: string): Promise<void | { success?: boolean; deferred?: boolean; leaseCount?: number }>;
    mkdirSftp(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<void>;
    deleteSftp?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<void>;
    renameSftp?(sftpId: string, oldPath: string, newPath: string, encoding?: SftpFilenameEncoding): Promise<void>;
    statSftp?(sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<SftpStatResult>;
    chmodSftp?(sftpId: string, path: string, mode: string, encoding?: SftpFilenameEncoding): Promise<void>;
    getSftpHomeDir?(sftpId: string, encoding?: SftpFilenameEncoding): Promise<{ success: boolean; homeDir?: string; error?: string }>;

    // Write binary with real-time progress callback
    writeSftpBinaryWithProgress?(
      sftpId: string,
      path: string,
      content: ArrayBuffer,
      transferId: string,
      encoding?: SftpFilenameEncoding,
      onProgress?: (transferred: number, total: number, speed: number) => void,
      onComplete?: () => void,
      onError?: (error: string) => void
    ): Promise<{ success: boolean; transferId: string; cancelled?: boolean }>;

    // Cancel an in-progress SFTP upload
    cancelSftpUpload?(transferId: string): Promise<{ success: boolean }>;

    // Transfer with progress
    uploadFile?(sftpId: string, localPath: string, remotePath: string, transferId: string): Promise<void>;
    downloadFile?(sftpId: string, remotePath: string, localPath: string, transferId: string): Promise<void>;
    cancelTransfer?(transferId: string): Promise<void>;
    /** Clear a pre-start cancel latch so intentional same-id resume/retry can run. */
    clearPendingTransferCancel?(transferId: string): Promise<{ success: boolean } | void>;
    sameHostCopyDirectory?(sftpId: string, sourcePath: string, targetPath: string, encoding?: SftpFilenameEncoding, transferId?: string): Promise<{ success: boolean }>;

    // Compressed folder upload
    startCompressedUpload?(
      options: {
        compressionId: string;
        folderPath: string;
        targetPath: string;
        sftpId: string;
        folderName: string;
      },
      onProgress?: (phase: string, transferred: number, total: number) => void,
      onComplete?: () => void,
      onError?: (error: string) => void
    ): Promise<{ compressionId: string; success?: boolean; error?: string }>;
    cancelCompressedUpload?(compressionId: string): Promise<{ success: boolean }>;
    pauseCompressedUpload?(compressionId: string): Promise<{ success: boolean; deferred?: boolean; reason?: string }>;
    resumeCompressedUpload?(compressionId: string): Promise<{ success: boolean; reason?: string }>;
    checkCompressedUploadSupport?(sftpId: string): Promise<{
      supported: boolean;
      localTar: boolean;
      remoteTar: boolean;
      error?: string;
    }>;

    onTransferProgress?(transferId: string, cb: (progress: SftpTransferProgress) => void): () => void;

    // Streaming transfer with real progress and cancellation
    startStreamTransfer?(
      options: {
        transferId: string;
        sourcePath: string;
        targetPath: string;
        sourceType: 'local' | 'sftp';
        targetType: 'local' | 'sftp';
        sourceSftpId?: string;
        targetSftpId?: string;
        sourceHostId?: string;
        targetHostId?: string;
        totalBytes?: number;
        sourceEncoding?: SftpFilenameEncoding;
        targetEncoding?: SftpFilenameEncoding;
        sameHost?: boolean;
        resumable?: boolean;
        checkpointBytes?: number;
        resumeStage?: 'direct' | 'download' | 'upload';
        downloadCheckpointBytes?: number;
        uploadCheckpointBytes?: number;
        sourceFingerprint?: string;
        pauseUnavailableReason?: string;
        globalConcurrency?: number;
        /** When true, skip main-process admission (renderer already scheduled). */
        skipAdmission?: boolean;
      },
      onProgress?: (transferred: number, total: number, speed: number, checkpoint?: {
        resumeStage?: 'direct' | 'download' | 'upload';
        checkpointBytes?: number;
        downloadCheckpointBytes?: number;
        uploadCheckpointBytes?: number;
        sourceFingerprint?: string;
      }) => void,
      onComplete?: () => void,
      onError?: (error: string) => void
    ): Promise<{ transferId: string; totalBytes?: number; error?: string }>;
    pauseTransfer?(transferId: string): Promise<{
      success: boolean;
      checkpointBytes?: number;
      resumeStage?: 'direct' | 'download' | 'upload';
      downloadCheckpointBytes?: number;
      uploadCheckpointBytes?: number;
      sourceFingerprint?: string;
      reason?: string;
    }>;
    resumeTransfer?(transferId: string): Promise<{ success: boolean; reason?: string }>;
    prioritizeTransfer?(transferId: string): Promise<{ success: boolean }>;
    setGlobalTransferConcurrency?(limit: number): Promise<{ success: boolean; limit: number }>;
    cleanupTransferArtifacts?(payload: {
      transferId: string;
      sourcePath: string;
      targetPath: string;
      targetSftpId?: string;
      targetEncoding?: SftpFilenameEncoding;
      stagedTargetPath?: string;
    }): Promise<{ success: boolean }>;
    onGlobalSftpTransferEvent?(callback: (event: {
      type: 'queued' | 'started' | 'progress' | 'paused' | 'resumed' | 'cancelled' | 'completed' | 'failed';
      transferId: string;
      direction?: TransferDirection;
      sourcePath?: string;
      targetPath?: string;
      startedAt?: number;
      endedAt?: number;
      error?: string;
      transferred?: number;
      totalBytes?: number;
      speed?: number;
      checkpointBytes?: number;
      resumeStage?: 'direct' | 'download' | 'upload';
      downloadCheckpointBytes?: number;
      uploadCheckpointBytes?: number;
      sourceFingerprint?: string;
      sessionId?: string;
      sourceHostId?: string;
      targetHostId?: string;
    }) => void): () => void;

    // Local filesystem operations
    listLocalDir?(path: string): Promise<RemoteFile[]>;
    readLocalFile?(path: string, options?: { maxBytes?: number }): Promise<ArrayBuffer>;
    writeLocalFile?(path: string, content: ArrayBuffer): Promise<void>;
    deleteLocalFile?(path: string): Promise<void>;
    renameLocalFile?(oldPath: string, newPath: string): Promise<void>;
    mkdirLocal?(path: string): Promise<void>;
    statLocal?(path: string): Promise<SftpStatResult>;
    listLocalTree?(path: string): Promise<Array<{
      localPath: string;
      relativePath: string;
      type: 'file' | 'directory';
      size: number;
      lastModified: number;
    }>>;
    getHomeDir?(): Promise<string>;
    listDrives?(): Promise<string[]>;
    getSystemInfo?(): Promise<{ username: string; hostname: string }>;
  }
}

export {};
