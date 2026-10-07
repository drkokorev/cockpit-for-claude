import { mock, test } from 'claude-code/testing'

// Prints the panel's real render trees with demo data, for README screenshots.
// Run from the repo root:
//   cp media/capture.tsx plugins/cockpit/tests/capture.test.tsx
//   claude plugin test plugins/cockpit | grep '^SCREEN' > media/screens.jsonl
//   rm plugins/cockpit/tests/capture.test.tsx && python3 media/render.py

const PANE = {
  plugin: 'cockpit',
  component: 'Pane',
  requestId: 'cockpit',
  props: { title: 'Cockpit', isFocused: false, bodyColumns: 78, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const DIFF = [
  '@@ -41,9 +41,14 @@ export class Session {',
  '   async refresh(): Promise<Token> {',
  '-    if (this.token.expiresAt > Date.now()) return this.token',
  '+    const skew = 30_000',
  '+    if (this.token.expiresAt - skew > Date.now()) return this.token',
  '+    const next = await this.store.rotate(this.token.refresh)',
  '+    this.emit("rotated", next.id)',
  '+    this.token = next',
  '     return this.token',
  '   }',
].join('\n')

test('capture', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    if (args.startsWith('git rev-parse')) return out('/Users/you/acme-web\n')
    if (args.startsWith('git diff --unified')) return out(DIFF + '\n')
    return out('')
  })
  await $.command.run({ command: 'cockpit-demo', args: '' } as Parameters<typeof $.command.run>[0])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shot = async (name: string) => console.log(`SCREEN ${name} ${JSON.stringify(await ui.drawn())}`)

  await shot('overview')
  await ui.press({ key: 'sec-TOOLS' })
  await ui.press({ key: 'tool-Bash' })
  await shot('tools')
  await ui.press({ key: 'tool-Bash' })
  await ui.press({ key: 'sec-TOOLS' })
  await ui.press({ key: 'agent-demo-agent-a' })
  await shot('agents')
  await ui.press({ key: 'agent-demo-agent-a' })
  await ui.press({ key: 'sec-FILES' })
  await ui.press({ key: 'file-src/auth/session.ts' })
  await shot('files')
  await ui.press({ key: 'file-src/auth/session.ts' })
  await ui.press({ key: 'sec-FILES' })
  await ui.press({ key: 'sec-CONTEXT' })
  await ui.press({ key: 'sec-COST' })
  await shot('context')
  await ui.unmount()

  const band = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 118, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  console.log(`SCREEN band ${JSON.stringify(await band.drawn())}`)
  await band.unmount()
})
