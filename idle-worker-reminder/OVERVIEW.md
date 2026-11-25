Reminds a manager agent when one of its workers has gone quiet. About ten minutes after a worker finishes a turn, with no new turn and no archive, the plugin adds a note to the worker's timeline and sends the worker's parent one short line: "worker <id> idle ~10 min: archive if accepted". It reminds once per idle period; a new turn starts a fresh period.

It only warns. It never archives anything. It ignores the top-level agent and any agent labelled studio.role=mm. Workers are agents with a parent and the label studio.task or studio.readonly.

The delay defaults to 10 minutes. Set the environment variable IDLE_WORKER_REMINDER_MS on the daemon, or put a number of milliseconds in the file ~/.local/state/paseo-plugins/idle-worker-reminder/delay_ms (read at each turn end), to change it.
