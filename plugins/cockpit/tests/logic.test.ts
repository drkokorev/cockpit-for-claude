import { expect, mock, test } from 'claude-code/testing'


test('the loop detector flags the same call repeated three times', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'hi', stderr: '' } }))
  for (let i = 0; i < 4; i += 1) {
    await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  }
  const loops = toasts.filter(text => text.includes('possible loop'))
  expect(loops).toHaveLength(1)
  expect(loops[0]).toContain('npm run build')
})

test('different calls do not raise a loop alert', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' } }))
  for (const command of ['ls', 'pwd', 'git status', 'ls']) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect(toasts.filter(text => text.includes('possible loop'))).toHaveLength(0)
})

test('a risky command is denied when the user blocks it', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { answers: { q: 'Block it' } } }))
  let didRun = false
  on('tool.call', { tool: 'Bash' }, () => {
    didRun = true
    return { result: { stdout: '', stderr: '' } }
  })
  const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(ran.isError === true || ran.deny !== undefined).toBe(true)
  expect(didRun).toBe(false)
})

test('an edit to a secrets file is stopped when the user blocks it', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { answers: { q: 'Block it' } } }))
  let didRun = false
  on('tool.call', { tool: 'Write' }, () => {
    didRun = true
    return { result: {} }
  })
  await $.tool.call({ tool: 'Write', file_path: '/repo/.env.local', content: 'KEY=1' })
  expect(didRun).toBe(false)
})
