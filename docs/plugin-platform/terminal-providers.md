# Terminal Provider API

PR 5 adds the host-owned terminal Provider registry on top of the isolated
runtime and permission boundary. Provider declarations remain immutable
manifest data. Listing Providers never starts a plugin; first invocation uses
the existing idempotent `onProvider:<id>` activation seam and revalidates the
active plugin version and runtime identity after the response.

## Runtime registration

An activated plugin registers only contributions owned by its exact plugin ID:

```ts
context.subscriptions.add(context.providers.register(
  "com.example.shell.completion",
  "terminal.completion",
  async ({ payload, cancellationToken }) => {
    if (cancellationToken.isCancellationRequested) return { items: [] };
    return { items: [{ text: "git status", displayText: "git status", score: 100 }] };
  },
));
```

Registration is activation-owned and disposable. A stale disposable cannot
remove a replacement registration. Invocation carries the declared Provider
ID/kind, an operation, a host-generated request ID, a bounded JSON payload, the
deadline, and a cooperative cancellation token. Results use the canonical
`ok`/`cancelled`/`failed` Provider result union and are validated again by the
main process before renderer use.

Each invocation reauthorizes the Provider kind's least-privilege permission
set against the current runtime identity before sending a session snapshot or
request payload. Required grants are reused; optional declarations prompt at
first use and denial/cancellation returns no terminal data to the runtime.

## Terminal snapshots and lifecycle

Providers receive immutable metadata snapshots containing only stable session
identity and presentation context: session/host/workspace IDs, protocol,
connection status, cwd, title, shell type, dimensions, and alternate-screen
state. Active runtimes can subscribe with `context.terminals.onDidChange()`.
Immediately before an invocation, a lazily activated Provider receives a
`snapshot` event for the current session so it does not depend on lifecycle
events that occurred before activation.
Lifecycle events cover creation, connection/reconnection, cwd/title/resize/
alternate-screen changes, command submission, disconnect, and disposal.
Ongoing lifecycle delivery begins only after a successful invocation with a
non-`once` `provider.terminal` grant. Each event rechecks that grant without
opening a new prompt and remains bound to the exact plugin version, runtime ID,
runtime kind, and security principal that received the authorized invocation.
One-use grants receive only the invocation snapshot and payload.

PR 5 intentionally omits command text, password/prompt content, raw terminal
output, xterm objects, backend handles, and terminal-worker ports. The ordinary
JSON-RPC Provider path is not suitable for hot interception. PR 6 owns the
separate permission-gated MessagePort fast path for input/output interceptors,
sensitive-input bypass, circuit breaking, and the 4 ms interceptor budget.

## Host adapters

Netcatty's built-in autocomplete engine and keyword highlighter use the same
application Provider adapters as plugins:

- completion requests run built-in and plugin Providers concurrently;
- one active request exists per session and Provider kind; a newer request
  cancels and suppresses the older result;
- Provider ordering is deterministic and can honor a host-owned preference
  list; completion items are score-ranked and text-deduplicated;
- one Provider failure is contained and does not suppress other Providers;
- plugin completion responses are capped and normalized before rendering;
- completion insertion/display text rejects control and bidirectional override
  characters before it can reach terminal input or suggestion UI. The host
  always renders the exact insertion text for third-party completions, so a
  friendly label cannot conceal a different command on previewless terminals;
- decoration Providers return declarative rules only. Rule IDs are namespaced,
  counts and strings are bounded, colors must be explicit hex values, and
  unsafe regular expressions are rejected before reaching the highlighter;
- decoration results are capped again at 64 total host rules after Provider
  fan-out, preventing many individually valid Providers from multiplying the
  renderer's regex workload.

The control-plane JSON budget remains 1 MiB, while each terminal Provider
payload and result is additionally limited to 128 KiB. Default terminal
Provider requests have a 1.5 second deadline; autocomplete uses a shorter 750
ms runtime deadline plus an 800 ms renderer-owned end-to-end wait bound that
also covers lazy activation and first-use authorization. Built-in suggestions
therefore remain available when a plugin prompt is unanswered. Renderer
request cancellation is owned by the requesting
WebContents and all outstanding work is aborted when that sender is destroyed.
A single renderer may retain at most 64 active terminal requests, and one
fan-out invokes at most the first 32 deterministically ranked Providers.

## Downstream compatibility

The registry uses the existing generic Provider request/result envelopes,
runtime identity, cancellation, progress, permission names, and stream
protocol. PR 6 can add its direct interceptor transport without changing the
ordinary registry. PR 7 connection/auth/import, PR 8 sync, and PR 9 rollout can
reuse the same registration and runtime lifecycle while defining their own
operation-specific result validators and bounded stream consumers.
