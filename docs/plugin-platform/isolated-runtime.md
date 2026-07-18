# Isolated plugin host runtime

Status: internal preview (`0.1.0-internal`)

This document describes phase 2 of the plugin platform tracked by
[#2269](https://github.com/binaricat/Netcatty/issues/2269). The runtime remains
hidden behind `NETCATTY_PLUGIN_DEV=1`; there is no public settings entry or
permission prompt yet.

## Installation transaction

The main process owns `userData/plugins/` and its SQLite database. A package is
never extracted directly into the active package tree. Installation performs
these steps:

1. open a non-symbolic `.ncpkg` source without following symlinks where the
   platform supports it;
2. copy it into a randomly named, mode-`0700` staging directory while hashing
   the exact bytes and detecting concurrent source changes;
3. validate and extract that private snapshot through the phase-1 package
   validator, including ZIP metadata, local/central header agreement, path
   aliases, size limits, CRC, manifest semantics, referenced resources, and
   companion digests;
4. write installation identity and archive digest metadata, sync the staged
   files, and rename the complete version directory into
   `packages/<pluginId>/<version>/`;
5. switch the active version in one SQLite transaction.

The file rename occurs before the database transaction. If the process exits
between them, startup recovery validates the committed directory and imports it
as a disabled version, even when an older version of that plugin was enabled.
Files left under `staging/` were never published and are removed. A database
row whose active package is missing or invalid is disabled and reported as an
error instead of being executed.

Uninstall uses the inverse two-phase move. The plugin directory first moves
under a marked `staging/remove-*` transaction and the database row is deleted
afterward. On restart, a remaining database row restores the directory, while
an already-deleted row completes removal. A crash cannot leave a live database
record pointing at a package that recovery discarded. A `remove-*` directory
created before any package was moved is harmless debris and is deleted even if
its metadata write was interrupted. Once a package has moved into that
directory, valid identity metadata is mandatory; missing or corrupt metadata
fails closed instead of deleting an unidentified package.

Installing the same version and archive is idempotent after the installed tree
is revalidated. Reusing the same plugin ID and version with a different archive
digest is rejected; version substitution must use a new version.

Install, enable/disable, restart and uninstall mutations share one manager
queue. A second renderer request cannot race an active-version switch or start
two runtimes for one plugin. Replacing an enabled version stops the old runtime
before activating the newly committed version. Activation failure preserves the
installed package for diagnosis but leaves it disabled.

## Database ownership

`plugins.sqlite` uses WAL, foreign keys, `synchronous=FULL`, explicit schema
versions, and immediate transactions. It records installed versions, the active
version, enabled state, runtime state, crash history, and namespaced JSON key /
value storage. Newer unknown database schemas fail closed.

Permission grants, encrypted settings and secrets are deliberately absent from
this phase. Those tables and brokers are introduced with the permission engine
so phase 2 cannot accidentally treat a manifest declaration as authorization.

## Runtime selection

An installed manifest can declare browser, Node, or both entrypoints. During
the internal preview the host uses this deterministic placement rule:

- a browser entrypoint is preferred whenever it exists;
- a Node entrypoint is used only when no browser entrypoint exists.

The rule keeps dual-target plugins on the least-privileged runtime. A later
trust phase may permit a user to select an advanced Node implementation, but it
must not silently upgrade an ordinary plugin.

### Ordinary browser runtime

Each ordinary plugin receives a hidden `BrowserWindow`, a unique in-memory
session, and a unique unguessable protocol authority. It runs with Chromium's
OS sandbox, `nodeIntegration=false`, `contextIsolation=true`, no DevTools,
dialogs, webviews, popups, navigation, permissions, downloads, or network
requests. The session is forced offline, uses an unreachable proxy without a
loopback bypass, and restricts WebRTC to proxied traffic. It accepts only the
matching `netcatty-plugin://` authority, which remains available while ordinary
network schemes are offline.

The protocol handler reads resources as bytes after decoded path validation,
realpath containment and regular-file checks. It serves a restrictive CSP,
runtime bootstrap modules, the public SDK/contract modules, and only that
runtime's package root. Runtime tokens are removed when the plugin stops, so a
stale document cannot reopen package resources.

The preload has one job: transfer one host-created MessagePort into the plugin
document. A three-stage handshake waits for preload readiness, port receipt and
installation of the plugin-side RPC listener, avoiding load-order message loss.
It does not expose Electron, Node, Netcatty's application preload, or an
arbitrary IPC channel.

Before importing package code, the bootstrap removes direct fetch, XHR,
WebSocket, WebTransport, WebRTC, beacon and worker globals. These APIs are not a
substitute for a future network permission: ordinary plugins will use the
phase-3 host broker when that permission is implemented.

### Advanced utility runtime

Node-only plugins run in a dedicated Electron `utilityProcess`, never in the
main process. The host passes a small environment, disables unsigned-library
loading, uses no shell, captures bounded stdout/stderr diagnostics, and checks
the entrypoint's realpath containment immediately before launch. A module loader
maps only the two public bare imports (`@netcatty/plugin-sdk` and
`@netcatty/plugin-contract`) to packaged host resources.

The utility process is an isolation and failure-containment boundary, not the
final permission boundary. Node plugins are still advanced code. Publisher
trust, explicit advanced-runtime consent, resource grants, companion policy and
quotas arrive in phases 3 and 9. This is one reason the entire runtime remains
behind the local development gate.

## RPC and streams

Both runtimes use the phase-1 JSON-RPC contract over one MessagePort. Every
incoming envelope passes the same depth/node JSON budget and the committed
JSON Schema before correlation or dispatch. Reserved initialize, cancellation,
progress and stream messages cannot fall through as generic methods.

The router provides:

- safe integer/string request correlation;
- a bounded pending and in-flight request count;
- request deadlines and `$/cancelRequest` propagation;
- host-assigned plugin identity on every handler call;
- immediate method-not-supported responses;
- method-specific validation of `plugin.initialize` results;
- rejection of unknown response IDs and malformed peers.

Stream frames use stable sequence numbers and byte credit. A sender stops when
credit reaches zero. Received credit is returned only after the consumer
releases the materialized chunk. Pending outbound bytes cannot exceed the
negotiated window, duplicate or out-of-order credit updates fail the peer, and
gaps in a direction's sequence fail just like duplicates. Unhandled streams are
cancelled immediately.

## Lifecycle and failure containment

The host performs compatibility and feature negotiation before activation,
then uses `plugin.initialize` and `plugin.activate`. Activation has a five-second
deadline. Normal stop requests `plugin.deactivate` with a two-second deadline
and then closes the port and process/window even if plugin cleanup hangs.

Unexpected renderer loss, utility-process exit, closed control ports and
protocol violations reject all pending work for only that plugin. Three failures
inside five minutes quarantine the plugin. Quarantine survives restart and is
cleared only by an explicit restart action. One plugin's state, process and
pending requests are never shared with another plugin.

Runtime logs are per-plugin, bounded and rotated. Structured fields whose names
look like credentials, passwords, tokens, secrets or private keys are redacted.
Secret storage is not emulated: the phase-2 SDK proxy rejects secret operations
until the phase-3 secure broker exists.

Application quit is coordinated with plugin shutdown after Netcatty's dirty
editor guard succeeds. Runtimes receive the two-second deactivation deadline;
the coordinator then fails open after a short outer deadline so a broken plugin
cannot make the application impossible to quit. The original `before-quit`
event remains cancelled until that asynchronous deadline finishes. On Windows
and Linux, closing the last tracked Netcatty content window initiates the same
quit path directly; hidden plugin host windows are deliberately excluded from
that count, so they cannot leave a headless application running.

## Development management bridge

The renderer management bridge exposes status, list, install, enable/disable,
restart and uninstall operations. The main process checks both the explicit
environment gate and the sender's trusted Netcatty origin for every operation.
With the gate off, the host service is not constructed and installed plugins do
not activate. Phase 4 will add the hidden management UI on top of this bridge.

## Packaged-resource invariant

The CLI, contract and SDK are root production dependencies, and their runtime
files plus the browser/utility bootstrap are declared packaged resources. Tests
lock this relationship so a dependency cleanup cannot produce a build that
installs plugins but fails to start them outside the repository checkout.

`npm run test:plugin-runtime` covers the pure main-process boundaries. The
separate `npm run test:plugin-runtime:electron` smoke launches both a real
sandboxed BrowserWindow plugin and a real utilityProcess plugin, verifies
bidirectional storage RPC, and checks the recorded runtime ownership.
