# Resume Guard

Blocks opening (resuming) an agent whose snapshot shows status `"error"` with a recorded context above a token threshold, because resuming such an agent pays for its whole context again. The block message tells the sender to write a handoff file and spawn a fresh agent instead.

## Behaviour

One `agent.open.before` hook. On every agent open (create, resume, refresh, import) it reads the agent snapshot and blocks the open, by throwing, exactly when both hold:

- `snapshot.status === "error"` (a crash surfaces as `error`, there is no separate crashed state), and
- `snapshot.lastUsage.contextWindowUsedTokens > thresholdTokens` (strictly above; default threshold 30 000).

It never blocks `running`, `idle`, `initializing`, or `closed` agents, whatever the token count, and never blocks when the token count is unknown. When the snapshot itself cannot be read the guard fails open (allows the open) and logs the error; blocking then would stall every agent open on a transient SDK failure. Unreadable settings never disable the guard: the default threshold is enforced.

The thrown error carries the whole deny message: it names the agent id, the approximate context (`~60k`), the threshold, and says: do not resume — write/refresh `<task>/workers/<agent-id>/handoff.md` and spawn a fresh agent pointed at it. `<task>` is a placeholder: the plugin cannot know which task directory the agent belongs to, so the sender fills it in.

## Known limit

A throw from `agent.open.before` surfaces to the client as the generic failure text `Plugin resume-guard agent.open.before failed: <message>`, not a custom deny message. The reason lives in the thrown error text for that reason. The hook only fires when a provider session opens; sending a prompt to an already-open errored agent does not pass through it.

## Settings

`thresholdTokens` (default 30000), under Settings → Plugins → Resume Guard, or by hand in `<paseoHome>/plugin-settings/resume-guard/config.json`.

## Install

```bash
paseo plugin install /absolute/path/to/paseo-plugins-local/resume-guard
paseo plugin ls            # resume-guard should show running
paseo plugin logs resume-guard
```

After editing: `paseo plugin reload resume-guard`. Requires Paseo >=0.15.0.

## Develop

```bash
npm install
npm run typecheck
npm test
```
