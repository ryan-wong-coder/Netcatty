/* eslint-disable no-undef */
const { runWhenProxyConnectionReady } = require("../proxyUtils.cjs");

function createExecCommandApi(ctx) {
  with (ctx) {
    async function execCommand(event, payload) {
      const enableKeyboardInteractive = !!payload.enableKeyboardInteractive;
      const commandTimeoutMs = payload.timeout || 10000;
      const { tcpConnectTimeoutMs, authReadyTimeoutMs } = resolveSshConnectionTimeouts(payload);
      const sender = event.sender;
      const sessionId = payload.sessionId || randomUUID();
      const hasCertificate = typeof payload.certificate === "string" && payload.certificate.trim().length > 0;
      const fallbackAgentSocket = payload.useSshAgent === false
        ? null
        : payload.useSshAgent === true
          ? undefined
          : await getAvailableAgentSocket();
      const systemAuthAgent = hasCertificate
        ? null
        : await prepareSystemSshAgentForAuth(payload, "[SSH Exec]");
      const defaultKeys = enableKeyboardInteractive && !(systemAuthAgent && payload.identitiesOnly)
        ? await findAllDefaultPrivateKeysFromHelper()
        : [];
      let identityFilePrivateKey = null;
      let identityFilePassphrase = null;
      const inlineKey = payload.privateKey && !systemAuthAgent
        ? await preparePrivateKeyForAuth({
          sender,
          privateKey: payload.privateKey,
          keyId: payload.keyId,
          keyName: payload.keyId || payload.username,
          hostname: payload.hostname,
          initialPassphrase: payload.passphrase,
          logPrefix: "[SSH Exec]",
        })
        : null;
    
      if (!payload.privateKey && !systemAuthAgent && payload.identityFilePaths?.length > 0) {
        for (const keyPath of payload.identityFilePaths) {
          try {
            const identityFile = await loadIdentityFileForAuth({
              sender,
              keyPath,
              hostname: payload.hostname,
              initialPassphrase: payload.passphrase,
              logPrefix: "[SSH Exec]",
            });
            if (!identityFile) {
              continue;
            }
            identityFilePrivateKey = identityFile.privateKey;
            identityFilePassphrase = identityFile.passphrase || null;
            break;
          } catch (err) {
            if (isPassphraseCancelledError(err)) {
              throw err;
            }
            console.warn("[SSH Exec] Failed to read identity file:", err?.message || err);
          }
        }
      }
    
      return new Promise((resolve, reject) => {
        const conn = new SSHClient();
        let stdout = "";
        let stderr = "";
        let settled = false;
        let commandTimer = null;
        let authReadyTimer = null;
        const clearTimers = () => {
          if (commandTimer) clearTimeout(commandTimer);
          if (authReadyTimer) clearTimeout(authReadyTimer);
          commandTimer = null;
          authReadyTimer = null;
        };
        const rejectConnection = (err) => {
          if (settled) return;
          settled = true;
          clearTimers();
          conn.end();
          reject(err);
        };
        const startCommandTimer = () => {
          commandTimer = setTimeout(() => {
            rejectConnection(new Error("SSH exec timeout"));
          }, commandTimeoutMs);
          commandTimer.unref?.();
        };
    
        conn
          .once("connect", () => {
            runWhenProxyConnectionReady(conn._sock, () => {
              try { conn._sock?.setTimeout?.(0); } catch { /* ignore */ }
              authReadyTimer = setTimeout(() => {
                rejectConnection(new Error(`SSH authentication timeout to ${payload.hostname}`));
              }, authReadyTimeoutMs);
              authReadyTimer.unref?.();
            });
          })
          .once("ready", () => {
            if (authReadyTimer) clearTimeout(authReadyTimer);
            authReadyTimer = null;
            startCommandTimer();
            conn.exec(payload.command, (err, stream) => {
              if (err) {
                clearTimers();
                settled = true;
                conn.end();
                return reject(err);
              }
              stream
                .on("data", (data) => {
                  stdout += data.toString();
                })
                .stderr.on("data", (data) => {
                  stderr += data.toString();
                })
                .on("close", (code) => {
                  if (settled) return;
                  clearTimers();
                  settled = true;
                  conn.end();
                  resolve({ stdout, stderr, code: code ?? (stderr ? 1 : 0) });
                });
            });
          })
          .on("error", (err) => {
            rejectConnection(err);
          })
          .once("timeout", () => {
            rejectConnection(new Error(`SSH connection timeout to ${payload.hostname}`));
          })
          .once("end", () => {
            if (settled) return;
            clearTimers();
            settled = true;
            if (stderr || stdout) {
              resolve({ stdout, stderr, code: 0 });
            } else {
              reject(new Error("SSH connection closed unexpectedly"));
            }
          });
    
        const connectOpts = {
          host: payload.hostname,
          port: payload.port || 22,
          username: payload.username,
          timeout: tcpConnectTimeoutMs,
          readyTimeout: 0,
          keepaliveInterval: 0,
          // Honor the host's algorithm settings so one-off commands (e.g. the
          // keychain "export public key to host" flow) negotiate with the same
          // KEX / cipher / host-key set as the interactive terminal. Without
          // this, a host that needs the ECDSA skip or legacy algorithms would
          // connect in the terminal but still fail the same handshake here.
          algorithms: buildAlgorithms(payload.legacyAlgorithms, {
            skipEcdsaHostKey: payload.skipEcdsaHostKey,
            algorithmOverrides: payload.algorithmOverrides,
          }),
        };
    
        let authAgent = null;
        const effectivePrivateKey = inlineKey?.privateKey || identityFilePrivateKey;
        const effectivePassphrase = inlineKey?.passphrase || identityFilePassphrase;
        if (systemAuthAgent) {
          connectOpts.agent = systemAuthAgent;
        } else if (hasCertificate) {
          authAgent = new NetcattyAgent({
            mode: "certificate",
            webContents: event.sender,
            meta: {
              label: payload.keyId || payload.username || "",
              certificate: payload.certificate,
              privateKey: effectivePrivateKey,
              passphrase: effectivePassphrase,
            },
          });
          connectOpts.agent = authAgent;
        } else if (effectivePrivateKey) {
          connectOpts.privateKey = effectivePrivateKey;
          if (effectivePassphrase) {
            connectOpts.passphrase = effectivePassphrase;
          }
        }
    
        if (payload.password) connectOpts.password = payload.password;
    
        let authBanner = "";
        if (enableKeyboardInteractive) {
          connectOpts.tryKeyboard = true;
    
          const authConfig = buildAuthHandler({
            authMethod: payload.authMethod,
            privateKey: connectOpts.privateKey,
            password: connectOpts.password,
            passphrase: connectOpts.passphrase,
            agent: connectOpts.agent,
            username: connectOpts.username,
            requiresMfa: !!payload.requiresMfa,
            logPrefix: "[SSH Exec]",
            defaultKeys,
            sshAgentSocketOverride: fallbackAgentSocket,
            allowAgentFallback: payload.useSshAgent !== false,
          });
    
          applyAuthToConnOpts(connectOpts, authConfig);
          const execAuthPhase = authConfig.authPhase || { hadPartialSuccess: false };

          conn.on("banner", (message) => {
            authBanner = String(message || "").trim();
          });
          conn.on("keyboard-interactive", createKeyboardInteractiveHandler({
            sender,
            sessionId,
            hostId: payload.hostId,
            hostname: payload.hostname,
            password: payload.password,
            logPrefix: "[SSH Exec]",
            scope: "external",
            requiresMfa: !!payload.requiresMfa,
            getAuthBanner: () => authBanner,
            shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(execAuthPhase),
          }));
        } else if (connectOpts.agent) {
          const order = ["agent"];
          if (connectOpts.password) order.push("password");
          connectOpts.authHandler = order;
        }
    
        conn.connect(connectOpts);
      });
    }

    return { execCommand };
  }
}

module.exports = { createExecCommandApi };
