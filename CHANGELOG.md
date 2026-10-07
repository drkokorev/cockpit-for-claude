# Changelog

## 1.0.0 (2026-10-07)

First public release.

- Side panel with twelve sections, each opening to details: Context, Limits, Cost, Turn, Agents, Tools, Files, Tests, Guard, Alerts, History, All-time
- Context: fill bar, what fills it (messages, system prompt, tools, memory files, MCP servers), the biggest tool outputs, and a Compact now button from 70%
- Limits: 5-hour and 7-day windows, reset countdowns, and a forecast of when a window fills at the current pace
- Cost: session and per-turn cost, spend per hour, prompt-cache hit rate, a prompt-cache countdown, tokens by model, and an optional budget (auto: shown with API billing, hidden on a subscription)
- Agents: every subagent with live status; open one for its steps, tokens, tool mix, timeline and result
- Tools: calls, errors and timings per tool; open a tool for its recent calls and error messages
- Files: changes vs HEAD; open a file for its diff
- Tests: last runs of common test commands, passed and failed counts
- Guard: asks before rm -rf, force push, reset --hard, sudo, curl | sh, DROP TABLE, kubectl delete, terraform destroy, npm publish, and edits to .env and key files
- Alerts: loop detector, compactions
- Band above the prompt and a status line where no side panel is shown
- Commands: /cockpit, /cockpit-report, /cockpit-export, /cockpit-budget, /cockpit-guard, /cockpit-cache, /cockpit-demo
