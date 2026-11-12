# Mode Guard

Rewrites the "Always Ask" permission mode (`modeId: "default"`) to `auto` when an agent is created, so unattended agents do not stall on permission prompts.

## Behaviour

One `agent.create.before` hook. If `request.config.modeId` is exactly `"default"` and the provider is one of `claude`, `claude-sandbox`, `deepseek`, `deepseek-lite`, `deepseek-orch`, `deepseek-sandbox`, `kimi` (the providers whose mode list has `auto`), it is changed to `"auto"` and one line is logged (provider and title, no prompt text). Everything else is left unchanged: `plan`, `acceptEdits`, `auto`, `bypassPermissions`, other providers, and an absent `modeId` (Paseo applies the provider default, `auto`). It never maps to `bypassPermissions`.

The hook cannot tell a deliberate Always Ask pick in the UI from an API call, so Always Ask is rewritten everywhere. The change is saved with the agent and stays after the plugin is removed. To add a provider, edit `GUARDED_PROVIDERS` in `shared/guard.ts` and reload.

## Install

```bash
paseo plugin install /absolute/path/to/paseo-plugins-local/mode-guard
paseo plugin ls            # mode-guard should show running
paseo plugin logs mode-guard
```

After editing: `paseo plugin reload mode-guard`. Requires Paseo >=0.15.0.

## Develop

```bash
npm install
npm run typecheck
npm test
```
