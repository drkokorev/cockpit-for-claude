# Cockpit

A live instrument panel for Claude Code, built as a mod: context fill, rate limits, cost, subagents, tool calls, changed files and test runs, each section opening to its details, plus a guard that asks before risky commands and edits to secrets files.

Works in the Claude Code terminal and the Claude desktop app (Code tab). Requires Claude Code v2.1.287 or later.

- `/cockpit` opens the panel
- `/cockpit-demo` fills it with sample data (`/cockpit-demo off` restores yours)
- `/cockpit-report`, `/cockpit-export`, `/cockpit-budget`, `/cockpit-guard`, `/cockpit-cache`

## What it runs, reads, writes and sends

Cockpit is one hooks module, `hooks/register.tsx`, readable TypeScript with no dependencies.

**Sends: nothing.** Cockpit makes no network requests and does not send the conversation, files or any other data anywhere. Everything it reads is shown in your own Claude Code window and stays on your machine.

**Programs it starts, and why.** Only `git`, only in your project, only to show changed files:

- `git diff --numstat HEAD` (or `git diff --numstat`) and `git ls-files --others --exclude-standard`: the list of changed and new files with +/- line counts, refreshed after an edit and after each turn
- `git rev-parse --show-toplevel` and `git diff --unified=1 --no-color [HEAD] -- <file>`: the diff of one file, only when you click that file in the Files section. `<file>` is the path git itself listed

**What it reads.** Through the Claude Code mods API: the session's usage figures (context, rate limits, cost), the tool calls Claude makes and their results (to count calls, time them, size their output and spot loops), the subagent list, and the model's turns. From disk: the contents of a new file only when you click it in Files. It never reads secrets files (`.env*`, keys, credentials) and shows "contents not read" for them instead.

**What it writes.** One file, `.cockpit/cockpit-report.md` in the session's working directory, only when you run `/cockpit-export` or press Export; each export replaces it. It never writes build, settings, start-up or instruction files. All-time totals (session, turn and tool-call counts, spend) are kept in the plugin's own store on your machine; session data lives in memory and ends with the session.

**Slash commands it runs itself.** One: `/compact`, and only when you press the **Compact now** button (shown when the context is over 70% and Claude is idle).

**Commands it adds.** `/cockpit`, `/cockpit-report`, `/cockpit-export`, `/cockpit-budget`, `/cockpit-guard`, `/cockpit-cache`, `/cockpit-demo`.

**Events it hooks.** `tool.call`: counts and times each call; for a risky Bash command or an edit to a secrets file it asks you first in Claude Code's own question dialog and refuses the call only if you block it. It never changes a call's input or result. `session.compact`: reads the result of a compaction to count it and show tokens before and after; it never changes the compaction. It also listens to `session.start`, `session.measure`, `turn.start`, `turn.step` and `turn.complete` to read figures, and draws its panel and band with `ui.render`.

**About "download-and-run" patterns in the source.** The text `curl … | sh` appears in `register.tsx` only as one of the guard's detection rules: Cockpit stops such a command and asks you. Cockpit itself never downloads or runs anything.

Full documentation, screenshots and the changelog: https://github.com/drkokorev/cockpit-for-claude
