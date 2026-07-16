import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  CloudProvider,
  ConvergentProviderBaselineV2,
  ConvergentSyncStateV2,
  SyncPayload,
  SyncedFile,
} from '../../../domain/sync.ts';
import {
  applyLegacySyncPayload,
  cloudSyncPayloadsEqual,
  createConvergentSyncStateFromPayload,
  materializeConvergentSyncState,
  materializeSyncPayloadFromConvergentState,
  mergeConvergentSyncStates,
  validateConvergentSyncPayload,
  withConvergentSyncEnvelope,
} from '../../../domain/convergentSync/index.ts';
import { EncryptionService } from '../EncryptionService.ts';
import type { CloudAdapter } from '../adapters/index.ts';
import {
  downgradeConvergentSyncImpl,
  resolveConvergentConflictAndSyncImpl,
  syncAllProvidersConvergentlyImpl,
  syncConvergentProvidersUnlockedImpl,
} from './convergentSyncRuntimeMethods.ts';

const NOW = 1_700_000_000_000;

function payload(label: string, username = 'root'): SyncPayload {
  return {
    hosts: [{
      id: 'host-1',
      label,
      hostname: 'example.com',
      port: 22,
      username,
      tags: [],
      os: 'linux',
    }],
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    notes: [],
    noteGroups: [],
    portForwardingRules: [],
    groupConfigs: [],
    syncedAt: NOW,
  };
}

function payloadWithHostCount(count: number): SyncPayload {
  return {
    ...payload('base'),
    hosts: Array.from({ length: count }, (_, index) => ({
      id: `host-${index}`,
      label: `Host ${index}`,
      hostname: `host-${index}.example.com`,
      port: 22,
      username: 'root',
      tags: [],
      os: 'linux' as const,
    })),
  };
}

function remoteState(
  base: ConvergentSyncStateV2,
  before: SyncPayload,
  after: SyncPayload,
  deviceId: string,
  now: number,
): ConvergentSyncStateV2 {
  return applyLegacySyncPayload(base, before, after, deviceId, now);
}

interface MemoryAdapter extends CloudAdapter {
  uploads: number;
  remote: SyncedFile | null;
  failDownload?: boolean;
  afterUpload?: (file: SyncedFile, adapter: MemoryAdapter) => void;
}

function adapter(initial: SyncedFile | null): MemoryAdapter {
  const result: MemoryAdapter = {
    isAuthenticated: true,
    accountInfo: null,
    resourceId: null,
    uploads: 0,
    remote: initial,
    signOut: () => {},
    initializeSync: async () => null,
    upload: async (file) => {
      result.uploads += 1;
      result.remote = file;
      result.afterUpload?.(file, result);
      return `resource-${result.uploads}`;
    },
    download: async () => {
      if (result.failDownload) throw new Error('provider unavailable');
      return result.remote;
    },
    deleteSync: async () => {},
    getTokens: () => null,
  };
  return result;
}

function manager(
  replica: ConvergentSyncStateV2,
  adapters: Partial<Record<CloudProvider, MemoryAdapter>>,
  baselines: Partial<Record<CloudProvider, ConvergentProviderBaselineV2>> = {},
) {
  const persisted: ConvergentSyncStateV2[] = [];
  let currentReplica = replica;
  const events: unknown[] = [];
  const providerConnections = Object.fromEntries(
    (['github', 'google', 'onedrive', 'webdav', 's3'] as CloudProvider[]).map((provider) => [
      provider,
      adapters[provider]
        ? { provider, status: 'connected' as const }
        : { provider, status: 'disconnected' as const },
    ]),
  ) as Record<CloudProvider, { provider: CloudProvider; status: 'connected' | 'disconnected'; resourceId?: string }>;
  return {
    masterPassword: 'pw',
    state: {
      securityState: 'UNLOCKED',
      syncState: 'IDLE',
      providers: providerConnections,
      deviceId: 'local-device',
      deviceName: 'Local device',
      syncStrategy: 'smartMerge',
      localVersion: 0,
      localUpdatedAt: 0,
      remoteVersion: 0,
      remoteUpdatedAt: 0,
      currentConflict: null,
      lastError: null,
      pendingLocalSync: false,
      convergentConflicts: materializeConvergentSyncState(replica).conflicts,
      syncHistory: [],
      lastShrinkFinding: undefined,
    },
    persisted,
    events,
    getConnectedAdapter: async (provider: CloudProvider) => adapters[provider],
    loadConvergentReplica: async () => ({ schemaVersion: 2 as const, state: currentReplica, updatedAt: NOW }),
    saveConvergentReplica: async (record: { state: ConvergentSyncStateV2 }) => {
      currentReplica = record.state;
      persisted.push(record.state);
    },
    loadConvergentProviderBaseline: async (provider: CloudProvider) => baselines[provider] ?? null,
    saveConvergentProviderBaseline: async (baseline: ConvergentProviderBaselineV2) => {
      baselines[baseline.provider] = baseline;
    },
    updateProviderStatus(provider: CloudProvider, status: 'connected' | 'syncing' | 'error', error?: string) {
      this.state.providers[provider] = { ...this.state.providers[provider], status, ...(error ? { error } : {}) };
    },
    emit: (event: unknown) => events.push(event),
    notifyStateChange: () => {},
    addSyncHistoryEntry: () => {},
    saveProviderConnection: async () => {},
    saveSyncConfig: () => {},
    exitBlockedState: () => {},
  };
}

function installEncryptionDouble() {
  const originalEncrypt = EncryptionService.encryptPayload;
  const originalDecrypt = EncryptionService.decryptPayload;
  const payloads = new Map<string, SyncPayload>();
  let sequence = 0;
  const register = (value: SyncPayload, version = 1, deviceId = 'remote'): SyncedFile => {
    const ciphertext = `cipher-${sequence += 1}`;
    payloads.set(ciphertext, value);
    return {
      meta: {
        version,
        updatedAt: NOW + sequence,
        deviceId,
        deviceName: deviceId,
        appVersion: 'test',
        iv: '',
        salt: '',
        algorithm: 'AES-256-GCM',
        kdf: 'PBKDF2',
        kdfIterations: 1,
        ...(value.convergentSync ? { syncSchemaVersion: 2 as const } : {}),
      },
      payload: ciphertext,
    };
  };
  EncryptionService.encryptPayload = async (value, _password, deviceId, _deviceName, _version, existingVersion) =>
    register(value, (existingVersion ?? 0) + 1, deviceId);
  EncryptionService.decryptPayload = async (file) => {
    const value = payloads.get(file.payload);
    if (!value) throw new Error('unknown test ciphertext');
    return value;
  };
  return {
    register,
    payloads,
    restore: () => {
      EncryptionService.encryptPayload = originalEncrypt;
      EncryptionService.decryptPayload = originalDecrypt;
    },
  };
}

test('unordered provider join preserves independent offline edits and persists before upload', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const githubState = remoteState(base, basePayload, payload('github-label'), 'github-device', NOW + 1);
    const googleState = remoteState(base, basePayload, payload('base', 'ubuntu'), 'google-device', NOW + 2);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(githubState, { syncedAt: NOW }), 2, 'github-device'));
    const google = adapter(encryption.register(withConvergentSyncEnvelope(googleState, { syncedAt: NOW }), 2, 'google-device'));
    const subject = manager(base, { github, google });
    let persistedBeforeUpload = false;
    const originalUpload = github.upload.bind(github);
    github.upload = async (file) => {
      persistedBeforeUpload = subject.persisted.length > 0;
      return originalUpload(file);
    };

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      basePayload,
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(persistedBeforeUpload, true);
    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('google')?.success, true);
    const merged = results.get('github')?.mergedPayload;
    assert.equal(merged?.hosts[0]?.label, 'github-label');
    assert.equal(merged?.hosts[0]?.username, 'ubuntu');
    assert.equal(subject.state.convergentConflicts.length, 0);
  } finally {
    encryption.restore();
  }
});

test('a concurrent provider write discovered during verification is rejoined and propagated', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 1, 'github-device'));
    const google = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 1, 'google-device'));
    let injected = false;
    github.afterUpload = (file, target) => {
      if (injected) return;
      injected = true;
      const outgoing = encryption.payloads.get(file.payload)!;
      const outgoingState = validateConvergentSyncPayload(file.meta, outgoing)!;
      const outgoingMaterialized = materializeSyncPayloadFromConvergentState(outgoingState, { syncedAt: NOW });
      const concurrent = remoteState(
        outgoingState,
        outgoingMaterialized,
        payload('provider-race'),
        'racing-device',
        NOW + 20,
      );
      target.remote = encryption.register(
        withConvergentSyncEnvelope(concurrent, { syncedAt: NOW + 20 }),
        file.meta.version + 1,
        'racing-device',
      );
    };
    const subject = manager(base, { github, google });

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      basePayload,
      { jitter: async () => {}, now: () => NOW + 30 },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('google')?.success, true);
    assert.equal(results.get('google')?.mergedPayload?.hosts[0]?.label, 'provider-race');
    assert.ok(google.uploads >= 2, 'the concurrent write should trigger another propagation round');
    const githubPayload = await EncryptionService.decryptPayload(github.remote!, 'pw');
    const googlePayload = await EncryptionService.decryptPayload(google.remote!, 'pw');
    const githubFinal = validateConvergentSyncPayload(github.remote!.meta, githubPayload)!;
    const googleFinal = validateConvergentSyncPayload(google.remote!.meta, googlePayload)!;
    assert.equal(
      cloudSyncPayloadsEqual(
        materializeSyncPayloadFromConvergentState(githubFinal, { syncedAt: NOW }),
        materializeSyncPayloadFromConvergentState(googleFinal, { syncedAt: NOW }),
      ),
      true,
    );
  } finally {
    encryption.restore();
  }
});

test('a failed provider does not roll back a provider that verified successfully', async () => {
  const encryption = installEncryptionDouble();
  try {
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 1));
    const google = adapter(null);
    google.failDownload = true;
    const subject = manager(base, { github, google });

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      localPayload,
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('google')?.success, false);
    assert.equal(subject.state.syncState, 'IDLE');
    assert.equal(subject.state.pendingLocalSync, true);
  } finally {
    encryption.restore();
  }
});

test('legacy cloud writes without a trusted provider baseline fail closed', async () => {
  const encryption = installEncryptionDouble();
  try {
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(payload('legacy'), 2, 'old-device'));
    const subject = manager(base, { github });

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      localPayload,
      { maxRounds: 1, jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.success, false);
    assert.match(results.get('github')?.error ?? '', /no trusted convergent baseline/i);
    assert.equal(github.uploads, 0);
  } finally {
    encryption.restore();
  }
});

test('provider order cannot change the joined materialized result', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const left = remoteState(base, basePayload, payload('left'), 'left', NOW + 1);
    const right = remoteState(base, basePayload, payload('right'), 'right', NOW + 2);
    const joinedA = mergeConvergentSyncStates(left, right);
    const joinedB = mergeConvergentSyncStates(right, left);
    assert.deepEqual(joinedA, joinedB);
  } finally {
    encryption.restore();
  }
});

test('preferCloud adopts the joined remote replica without creating a local conflict', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const remote = remoteState(base, basePayload, payload('cloud'), 'cloud-device', NOW + 1);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(remote, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });
    subject.state.syncStrategy = 'preferCloud';

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      payload('unsaved-local'),
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.mergedPayload?.hosts[0]?.label, 'cloud');
    assert.equal(results.get('github')?.convergentConflictCount, 0);
  } finally {
    encryption.restore();
  }
});

test('preferLocal creates a causal write that dominates a remote edit', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const remote = remoteState(base, basePayload, payload('cloud'), 'cloud-device', NOW + 1);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(remote, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });
    subject.state.syncStrategy = 'preferLocal';

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      payload('local-wins'),
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.mergedPayload?.hosts[0]?.label, 'local-wins');
    assert.equal(results.get('github')?.convergentConflictCount, 0);
  } finally {
    encryption.restore();
  }
});

test('a trusted baseline converts an old-client v1 write into deterministic causal writes', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const github = adapter(encryption.register(payload('legacy-edit'), 2, 'old-device'));
    const baseline: ConvergentProviderBaselineV2 = {
      schemaVersion: 2,
      provider: 'github',
      remoteVersion: 1,
      remoteUpdatedAt: NOW,
      remoteDeviceId: 'old-device',
      materializedPayload: basePayload,
      state: base,
    };
    const subject = manager(base, { github }, { github: baseline });

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      basePayload,
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('github')?.mergedPayload?.hosts[0]?.label, 'legacy-edit');
  } finally {
    encryption.restore();
  }
});

test('the production entry fails closed when another window owns the Web Lock', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: null) => unknown) => callback(null),
        },
      },
    });
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 1));
    const subject = manager(base, { github });

    const results = await syncAllProvidersConvergentlyImpl.call(subject, localPayload);

    assert.equal(results.get('github')?.success, false);
    assert.match(results.get('github')?.error ?? '', /already running in another window/i);
    assert.equal(github.uploads, 0);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('explicit downgrade replaces v2 only after a verified legacy write', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });

    const results = await downgradeConvergentSyncImpl.call(subject, true);

    assert.equal(results.get('github')?.success, true);
    assert.equal(github.remote?.meta.syncSchemaVersion, undefined);
    const verified = await EncryptionService.decryptPayload(github.remote!, 'pw');
    assert.equal(verified.convergentSync, undefined);
    assert.equal(verified.hosts[0]?.label, 'local');
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('conflict resolution and provider propagation share one Web Lock', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    let lockCalls = 0;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => {
            lockCalls += 1;
            return callback({});
          },
        },
      },
    });
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const left = remoteState(base, basePayload, payload('left'), 'left-device', NOW + 1);
    const right = remoteState(base, basePayload, payload('right'), 'right-device', NOW + 2);
    const conflicted = mergeConvergentSyncStates(left, right);
    const conflict = materializeConvergentSyncState(conflicted).conflicts.find(
      (entry) => entry.address.kind === 'entity-field' && entry.address.field === 'label',
    )!;
    const selected = conflict.candidates.find((candidate) => candidate.value === 'left')!;
    const github = adapter(encryption.register(withConvergentSyncEnvelope(conflicted, { syncedAt: NOW }), 2));
    const subject = manager(conflicted, { github });

    const result = await resolveConvergentConflictAndSyncImpl.call(
      subject,
      JSON.stringify(['entity-field', 'hosts', 'host-1', 'label']),
      `${selected.dot.deviceId}:${selected.dot.counter}`,
      async (_payload: SyncPayload, commitReplica: () => Promise<void>) => {
        await commitReplica();
      },
    );

    assert.equal(lockCalls, 1);
    assert.equal(result.results.get('github')?.success, true);
    assert.equal(result.payload.hosts[0]?.label, 'left');
    assert.equal(subject.state.convergentConflicts.length, 0);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('a failed protected apply publishes neither the resolution replica nor a provider write', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const left = remoteState(base, basePayload, payload('left'), 'left-device', NOW + 1);
    const right = remoteState(base, basePayload, payload('right'), 'right-device', NOW + 2);
    const conflicted = mergeConvergentSyncStates(left, right);
    const conflict = materializeConvergentSyncState(conflicted).conflicts.find(
      (entry) => entry.address.kind === 'entity-field' && entry.address.field === 'label',
    )!;
    const selected = conflict.candidates[0]!;
    const github = adapter(encryption.register(withConvergentSyncEnvelope(conflicted, { syncedAt: NOW }), 2));
    const subject = manager(conflicted, { github });

    await assert.rejects(() => resolveConvergentConflictAndSyncImpl.call(
      subject,
      JSON.stringify(['entity-field', 'hosts', 'host-1', 'label']),
      `${selected.dot.deviceId}:${selected.dot.counter}`,
      async () => {
        throw new Error('protective apply failed');
      },
    ), /protective apply failed/);

    assert.equal(subject.persisted.length, 0);
    assert.equal(github.uploads, 0);
    assert.equal(subject.state.convergentConflicts.length, 1);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('suspicious local shrink is blocked before replica persistence or provider upload', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payloadWithHostCount(6);
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });
    const emptied = { ...basePayload, hosts: [] };

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      emptied,
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.shrinkBlocked, true);
    assert.equal(subject.persisted.length, 0);
    assert.equal(github.uploads, 0);
    assert.equal(subject.state.syncState, 'BLOCKED');
  } finally {
    encryption.restore();
  }
});

test('one-shot shrink override produces causal deletions and verifies them', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payloadWithHostCount(6);
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });
    subject.state.syncState = 'BLOCKED';
    subject.state.lastShrinkFinding = {
      suspicious: true,
      reason: 'bulk-shrink',
      entityType: 'hosts',
      baseCount: 6,
      outgoingCount: 0,
      lost: 6,
    };
    const emptied = { ...basePayload, hosts: [] };

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      emptied,
      { overrideShrink: true, jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('github')?.mergedPayload?.hosts.length, 0);
    assert.equal(subject.state.syncState, 'IDLE');
    assert.equal(subject.state.lastShrinkFinding, undefined);
  } finally {
    encryption.restore();
  }
});

test('all five provider adapters converge independent field edits into one replica', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const edits: Array<[CloudProvider, SyncPayload]> = [
      ['github', payload('github-label')],
      ['google', payload('base', 'google-user')],
      ['onedrive', { ...basePayload, hosts: [{ ...basePayload.hosts[0]!, hostname: 'onedrive.example.com' }] }],
      ['webdav', { ...basePayload, hosts: [{ ...basePayload.hosts[0]!, port: 2200 }] }],
      ['s3', { ...basePayload, hosts: [{ ...basePayload.hosts[0]!, tags: ['s3-tag'] }] }],
    ];
    const adapters = Object.fromEntries(edits.map(([provider, edited], index) => {
      const state = remoteState(base, basePayload, edited, `${provider}-device`, NOW + index + 1);
      return [provider, adapter(encryption.register(
        withConvergentSyncEnvelope(state, { syncedAt: NOW }),
        2,
        `${provider}-device`,
      ))];
    })) as Record<CloudProvider, MemoryAdapter>;
    const subject = manager(base, adapters);

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      basePayload,
      { jitter: async () => {}, now: () => NOW + 20 },
    );

    assert.equal([...results.values()].every((result) => result.success), true);
    assert.equal(results.size, 5);
    const host = results.get('github')?.mergedPayload?.hosts[0];
    assert.equal(host?.label, 'github-label');
    assert.equal(host?.username, 'google-user');
    assert.equal(host?.hostname, 'onedrive.example.com');
    assert.equal(host?.port, 2200);
    assert.deepEqual(host?.tags, ['s3-tag']);
  } finally {
    encryption.restore();
  }
});
