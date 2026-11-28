# Resume Guard

Blocks opening (resuming) an agent whose snapshot shows status `"error"` with a recorded context above a token threshold, because resuming such an agent pays for its whole context again. The block message tells the sender to write a handoff file and spawn a fresh agent instead.

## Behaviour

One `agent.open.before` hook. On every agent open (create, resume, refresh, import) it reads the agent snapshot and blocks the open, by throwing, exactly when both hold:

- `snapshot.status === "error"` (a crash surfaces as `error`, there is no separate crashed state), and
- `snapshot.lastUsage.contextWindowUsedTokens > thresholdTokens` (strictly above; default threshold 30 000).

It never blocks `running`, `idle`, `initializing`, or `closed` agents, whatever the token count, and never blocks when the token count is unknown. When the snapshot itself cannot be read the guard fails open (allows the open) and logs the error; blocking then would stall every agent open on a transient SDK failure. Unreadable settings never disable the guard: the default threshold is enforced.

The thrown error carries the whole deny message: it names the agent id, the approximate context (`~60k`), the threshold, and says: do not resume — write/refresh `<task>/workers/<agent-id>/handoff.md` and spawn a fresh agent pointed at it. `<task>` is a placeholder: the plugin cannot know which task directory the agent belongs to, so the sender fills it in.

## Rotation exemption

ZeroSub moves an agent that hit an account limit by reloading it (`reason: "refresh"`), and that agent is in status `"error"`, so the guard would block the move. One such refresh per agent is therefore allowed when all hold: `reason === "refresh"`, status `"error"`, the agent is not archived, and the tail of its timeline (20 items) contains a CLI limit notice ("You've hit your 5-hour limit", "You've reached your … limit", "The usage limit has been reached"). Every other open (resume, import, create-with-history, a refresh without a limit notice) is still blocked.

The exemption is spent when granted: a second one for the same agent within `rotationExemptMinutes` (default 30) is blocked, which stops reload loops. The grant time is kept in memory and in `$XDG_STATE_HOME/paseo-plugins/resume-guard/rotation-allowed.json`. Allows are logged as `rotation allow`.

Evidence is timeline text, not a ZeroSub `zerosub.state` call: the plugin SDK documents no plugin-to-plugin RPC. The payload alone cannot tell a rotation from a manual refresh, so a manual refresh of a limit-errored agent is also allowed once.

## Known limit

A throw from `agent.open.before` surfaces to the client as the generic failure text `Plugin resume-guard agent.open.before failed: <message>`, not a custom deny message. The reason lives in the thrown error text for that reason. The hook only fires when a provider session opens; sending a prompt to an already-open errored agent does not pass through it.

## Settings

`thresholdTokens` (default 30000) and `rotationExemptMinutes` (default 30), under Settings → Plugins → Resume Guard, or by hand in `<paseoHome>/plugin-settings/resume-guard/config.json`.

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
