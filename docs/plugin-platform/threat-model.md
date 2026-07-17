# Plugin platform threat model

Status: phase 1 contract baseline

Plugins are untrusted code. A useful plugin may parse terminal output, display
content, call remote services, or ship a native companion; none of those needs
imply trust in the author's code, update server, dependencies, or account.

This threat model records the security properties that the nine-stage platform
must preserve. Phase 1 enforces package-format properties and defines the wire
types. Later phases implement process isolation and capability mediation.

## Protected assets

- passwords, private keys, API keys, OTP values, and secret-setting plaintext;
- terminal input while echo is disabled or authentication is in progress;
- host addresses, usernames, notes, command history, and terminal output;
- local files and filesystem metadata outside a plugin's data directory;
- Netcatty renderer and main-process authority, Electron IPC, and Node APIs;
- other plugins' packages, storage, logs, settings, and runtime messages;
- cloud synchronization keys and provider credentials;
- the integrity and availability of terminal sessions and the Netcatty process.

## Adversaries

The design assumes any of the following may be hostile:

- a locally installed plugin package;
- a plugin dependency compromised after publication;
- a publisher account or distribution server;
- a companion executable;
- remote content rendered or parsed by a plugin;
- a malformed or intentionally expensive RPC peer;
- an old package crafted to exploit a newer installer;
- an update that requests broader permissions than the installed version.

The operating system, Electron sandbox, Netcatty application package, and user
account are trusted. A machine already controlled by malware is outside the
platform's protection boundary.

## Package attacks

### Archive traversal and aliasing

ZIP entries can target an absolute path, contain `..`, use backslashes on
Windows, differ only by case, or exploit reserved device names. Extractors may
then write outside staging or overwrite a different entry.

The contract CLI accepts one normalized POSIX spelling for each path and
rejects exact, Unicode compatibility, and case-folded duplicates. The phase 2
installer must run the same validation before extraction and must extract only
under a newly created staging directory.

Every archive entry uses the ZIP UTF-8 flag. Validation compares the raw
central-directory name with the local-header name and also requires matching
flags, compression method, CRC, and sizes, preventing different ZIP readers
from validating and extracting different interpretations of one package.

Manifest decoding is fatal UTF-8 on both source directories and archives.
Malformed byte sequences cannot be normalized differently by separate package
inspection and installation paths.

### Symbolic links and executable smuggling

A symbolic link can make an apparently safe relative path resolve outside the
package. An executable bit can also hide an undeclared native program among
ordinary assets.

Packages cannot contain symbolic links. Executable files must appear in a
platform-specific `companionExecutables[].variants` entry; every variant binds
its package path, supported target platforms, and content SHA-256. A later
signature covers both the manifest and deterministic archive.

### Resource exhaustion

Small compressed inputs can expand into very large outputs, or contain huge
file counts and path names. Both source packing and archive validation impose
limits on archive bytes, expanded bytes, individual files, entry count,
manifest bytes, and path bytes. The installer must enforce limits while
streaming, before committing package metadata.

A byte limit alone does not bound parser work: a small manifest can contain
thousands of nested arrays or a very large number of tiny JSON values. Manifest
validation therefore applies explicit depth and node-count budgets before the
recursive JSON Schema validator runs. Exceeding either budget is an ordinary
package validation failure, not an uncaught stack overflow.

## Runtime attacks reserved for later phases

### Renderer escape

Normal plugins will run in a sandboxed Chromium context without Node,
`contextIsolation` bypasses, arbitrary Electron IPC, or direct access to the
application React tree and xterm instance. Plugin documents use a dedicated
protocol with a restrictive Content Security Policy. Privileged plugins run in
separate utility processes rather than the Netcatty main process.

### Confused deputy

A plugin may ask the host to act on another plugin, terminal, host, file, or
network origin. Every request must carry runtime identity assigned by the host;
the host must ignore plugin-supplied identity fields. Capability handlers check
the sender, active operation, declared permission, user grant, and resource
scope before using application authority.

### Permission laundering

A plugin could call a broadly capable built-in command or another plugin to
avoid its own permission check. Public commands therefore retain caller
identity, and capability checks occur at the final privileged boundary rather
than only in UI or command registration.

### Secret exfiltration

Secret values are never ordinary settings or JSON-RPC results. The credential
broker uses operation-bound, single-use leases. Terminal sensitive-input mode
bypasses third-party hooks unconditionally. Logs, diagnostics, synchronization,
and crash reports redact secret fields before persistence.

### Denial of service

RPC requests have deadlines and cancellation IDs. Streams have explicit byte
windows. The runtime supervisor will enforce activation and shutdown deadlines,
message-rate and memory quotas, crash quarantine, and terminal interceptor
circuit breakers. A failed plugin must not stop unrelated plugins or terminal
sessions.

Runtime decoders must apply exact schemas for reserved methods instead of
accepting malformed reserved messages as generic RPC. Transferable stream data
is brand-checked through the native `ArrayBuffer` internal slot; an object that
only spoofs `Symbol.toStringTag` or `byteLength` is not a transferable buffer.
JSON serialization reads validated own data properties directly and never
executes inherited `toJSON()` hooks supplied through a hostile prototype.
All RPC and stream JSON values use the same depth and node-count budgets so a
validly framed peer cannot consume an unbounded call stack or validation loop.
The stdio decoder also consumes fragmented byte queues by advancing an index
rather than repeatedly shifting arrays. Small fragments are copied into bounded
slabs, preventing both quadratic work and per-byte object retention when a peer
delivers a large frame in very small chunks. Copying also prevents a caller from
mutating queued Node.js `Buffer` storage after `push()` returns.

### Update substitution and rollback

The final distribution stage uses signed repository metadata, publisher
signatures, staged health checks, atomic version switching, and rollback to the
last healthy version. Permission, API, or trust-level increases require a new
user decision; an existing grant is not silently widened.

## Security invariants

The platform is not ready for public enablement unless all of these hold:

1. Ordinary plugins have no ambient Node, Electron, filesystem, network, React,
   or xterm authority.
2. A declaration is not a grant, and a grant is limited to its declared
   resource and lifetime.
3. No renderer means interactive permission requests fail closed.
4. Password and no-echo input never reaches plugin hooks.
5. The package installed is the package validated and, later, signed.
6. A plugin cannot address another plugin's storage or runtime by changing an
   identifier in its request.
7. Plugin failure is contained and the terminal data path fails open only where
   disclosure is impossible.
8. Secrets never enter manifests, package defaults, logs, diagnostics, or cloud
   synchronization sidecars.
9. Unknown newer protocol versions fail closed at privileged boundaries.
10. Disabling every plugin restores the unextended Netcatty behavior and does
    not impose more than the agreed terminal throughput budget.

## Phase 1 limitations

No plugin code is loaded by this PR. The SDK context has interfaces but no host
implementation. The schema bundle is committed for drift checking but is not
wired into Electron. This limits phase 1's attack surface to developer tooling
and package validation while allowing the runtime work to be reviewed
separately.
