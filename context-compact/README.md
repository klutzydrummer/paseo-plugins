# Context Compact

Sets the Claude Code auto-compaction threshold (a percent of a token window) for every Claude session Paseo opens, with an optional nudge to save notes before compaction.

See [OVERVIEW.md](OVERVIEW.md) for what it shows, how it works, its limits and the data it touches.

## Install

```bash
paseo plugin add git:sbhas2k/paseo-plugins:context-compact
```

Requires Paseo >=0.15.0.

## Nudges

Two nudges per arm, sent at turn end once the context passes a share of `windowTokens`:

- **Soft** at `handoffPct` (default 50): finish the current step, start no new phase, self-hand off at the next clean stopping point (`handoffPrompt`).
- **Hard** at `hardHandoffPct` (default 75, 0 = off): hand off now (`hardHandoffPrompt`).

Each fires at most once; both re-arm when the context drops back under `handoffPct` (after a compaction or `/clear`). Nothing is sent at or over `compactPct`, which is unchanged. If the context jumps past `hardHandoffPct` in one turn, only the hard nudge is sent. `handoffPct` 0 turns all nudges off. Both prompts accept `{pct}`, `{window}`, `{compact}`.

Both texts tell the agent to hand off by itself, without asking the user: write its state file and a handoff file, call `stow_handoff(<short pointer text>)` (the pointer says the handoff file is the source of truth and wins on conflict), then end its turn. Without `stow_handoff`, it writes the handoff file and reports the path to its parent (the user, if top level). A `handoffPrompt` already saved in the plugin settings overrides the soft default; a config without `hardHandoffPct` / `hardHandoffPrompt` gets their defaults.

## Which agents are nudged

Top-level agents always. A child agent (one with a parent) only if it carries an opt-in label: `nudgeLabelKey` = `nudgeLabelValue`, default `studio.role` = `mm` (e.g. a middle manager spawned with `--label studio.role=mm`). Children without that label (workers) are never nudged. An empty `nudgeLabelKey` turns the child opt-in off. Existing saved configs keep working: the new keys take their defaults.

## stow_handoff tool

Agents get `stow_handoff(text)` (Paseo >= 0.15.0), top-level or child; it does not depend on the nudge label. The calling agent's id comes from the tool context (`context.agent.id`), never a parameter. On that agent's next completed `agent.turn_ended` the plugin sends `/clear`, waits for idle (settle 1 s, two idle reads, 60 s timeout), then sends the text; the note is deleted before sending. Notes are persisted one file per agent id (mode 0600, directory 0700, atomic write) under `$XDG_STATE_HOME/paseo-plugins/context-compact/stow/` (default `~/.local/state/...`), since Paseo's plugin API has no data directory; they are loaded at plugin startup, so a daemon restart does not lose a pending note, and notes older than 24 h are dropped. The sequence runs detached because hooks time out after 30 s. Sends go through `paseo.agents.ref(id).send(...)` without `sourceAgentId`, the only SDK option that carries agent provenance (`SendMessageOptions` in `@getpaseo/client`), so no caller header is expected. Verified live on 2026-11-10 (plain claude haiku-5-5, plugin loaded from this branch): the agent called `stow_handoff` and ended its turn, `/clear` ran as a command ("Claude switched to a new session"), the stowed text arrived as the next user message, the agent had lost earlier memory and kept its Paseo ID, and no caller header arrived.

## Develop

```bash
npm install
npm run typecheck
npm test
paseo plugin add ./context-compact    # from a clone of this repository
```

## License

MIT
