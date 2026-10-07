import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'cockpit',
  component: 'Pane',
  requestId: 'cockpit',
  props: {
    title: 'Cockpit',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the cockpit pane draws and toggles on every surface', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /COCKPIT/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /CONTEXT/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /GUARD/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /window/ })).toBeUndefined()
    await ui.press({ key: 'sec-CONTEXT' })
    expect(await ui.find({ type: 'Text', text: /window/ })).toBeDefined()
    await ui.press({ key: 'sec-CONTEXT' })
    expect(await ui.find({ type: 'Text', text: /window/ })).toBeUndefined()
    await ui.press({ key: 'sections' })
    expect(await ui.find({ type: 'Text', text: /watches:/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /calls/ })).toBeDefined()
    await ui.press({ key: 'sections' })
    expect(await ui.find({ type: 'Text', text: /watches:/ })).toBeUndefined()
    await ui.press({ key: 'compact' })
    expect(await ui.find({ type: 'Button', text: /GUARD/ })).toBeUndefined()
    await ui.press({ key: 'compact' })
    expect(await ui.find({ type: 'Button', text: /GUARD/ })).toBeDefined()
    await ui.press({ key: 'guard' })
    expect(await ui.find({ type: 'Button', text: /Guard: off/ })).toBeDefined()
    await ui.press({ key: 'guard' })
    expect(await ui.find({ type: 'Button', text: /AGENTS/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /COST/ })).toBeDefined()
    await ui.press({ key: 'money' })
    expect(await ui.find({ type: 'Button', text: /COST/ })).toBeUndefined()
    await ui.press({ key: 'money' })
    expect(await ui.find({ type: 'Button', text: /Budget: auto/ })).toBeDefined()
    await ui.press({ key: 'budget' })
    expect(await ui.find({ type: 'Button', text: /Budget: on/ })).toBeDefined()
    await ui.press({ key: 'budget' })
    await ui.press({ key: 'budget' })
    await ui.unmount()
  }
})

test('the cockpit band draws above the prompt on every surface', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cockpit',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /Cockpit/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Panel/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a tool opens to its recent calls with error text', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, (_, e) =>
    e.command === 'npm run lint' ? { result: { stdout: '', stderr: 'boom' }, isError: true, text: 'lint failed: 3 problems' } : { result: { stdout: 'ok', stderr: '' } },
  )
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'sec-TOOLS' })
    await ui.press({ key: 'tool-Bash' })
    expect(await ui.find({ type: 'Text', text: /npm run lint/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /lint failed/ })).toBeDefined()
    await ui.press({ key: 'tool-Bash' })
    await ui.press({ key: 'sec-TOOLS' })
    await ui.unmount()
  }
})

test('big tool outputs show up as context hogs', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { content: '' }, text: 'x'.repeat(48_000) }))
  await $.tool.call({ tool: 'Read', file_path: '/repo/package-lock.json' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'sec-TOOLS' })
    expect(await ui.find({ type: 'Text', text: /context hogs/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /package-lock\.json/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~12k/ })).toBeDefined()
    await ui.press({ key: 'sec-TOOLS' })
    await ui.unmount()
  }
})

test('a changed file opens to its diff', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  const out = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    if (args.startsWith('git diff --numstat')) return out(0, '3\t1\tsrc/app.ts\n1\t0\tconfig/.env.production\n')
    if (args.startsWith('git ls-files')) return out(0, '')
    if (args.startsWith('git rev-parse')) return out(0, '/repo\n')
    if (args.startsWith('git diff --unified')) return out(0, '@@ -1,2 +1,4 @@\n-old line\n+new line\n context\n')
    return out(1, '')
  })
  let readSecret = false
  on('fs.read', () => {
    readSecret = true
    return { value: '' }
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }))
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sec-FILES' })
  await ui.press({ key: 'file-src/app.ts' })
  expect(await ui.find({ type: 'Text', text: /\+new line/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /-old line/ })).toBeDefined()
  await ui.press({ key: 'file-src/app.ts' })
  expect(await ui.find({ type: 'Text', text: /\+new line/ })).toBeUndefined()
  await ui.press({ key: 'file-config/.env.production' })
  expect(await ui.find({ type: 'Text', text: /contents not read/ })).toBeDefined()
  expect(readSecret).toBe(false)
  await ui.unmount()
})

test('demo data opens an agent card with its timeline and result', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  await $.command.run({ command: 'cockpit-demo', args: '' } as Parameters<typeof $.command.run>[0])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'agent-demo-agent-a' })
    expect(await ui.find({ type: 'Text', text: /timeline/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Found 6 readers/ })).toBeDefined()
    await ui.press({ key: 'agent-demo-agent-a' })
    await ui.press({ key: 'sections' })
    expect(await ui.find({ type: 'Text', text: /by model/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cache in use/ })).toBeDefined()
    await ui.press({ key: 'sections' })
    await ui.unmount()
  }
})
