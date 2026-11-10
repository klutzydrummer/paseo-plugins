# Context Compact

Sets the Claude Code auto-compaction threshold (a percent of a token window) for every Claude session Paseo opens, with an optional nudge to save notes before compaction.

See [OVERVIEW.md](OVERVIEW.md) for what it shows, how it works, its limits and the data it touches.

## Install

```bash
paseo plugin add git:sbhas2k/paseo-plugins:context-compact
```

Requires Paseo >=0.12.0.

## stow_handoff tool

Agents get `stow_handoff(text)` (Paseo >= 0.15.0). The calling agent's id comes from the tool context (`context.agent.id`), never a parameter. On that agent's next completed `agent.turn_ended` the plugin sends `/clear`, waits for idle (settle 1 s, two idle reads, 60 s timeout), then sends the text; the entry is deleted before sending. The sequence runs detached because hooks time out after 30 s. Sends go through `paseo.agents.ref(id).send(...)` without `sourceAgentId`, the only SDK option that carries agent provenance (`SendMessageOptions` in `@getpaseo/client`), so no caller header is expected. Verified live on 2026-11-10 (plain claude haiku-5-5, plugin loaded from this branch): the agent called `stow_handoff` and ended its turn, `/clear` ran as a command ("Claude switched to a new session"), the stowed text arrived as the next user message, the agent had lost earlier memory and kept its Paseo ID, and no caller header arrived.

## Develop

```bash
npm install
npm run typecheck
npm test
paseo plugin add ./context-compact    # from a clone of this repository
```

## License

MIT
