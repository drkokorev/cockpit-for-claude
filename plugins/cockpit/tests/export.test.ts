import { expect, mock, test } from 'claude-code/testing'

test('export answers with a saved path', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  const written: string[] = []
  on('fs.write', (_, e) => {
    written.push(e.path)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  const out = await $.command.run({ command: 'cockpit-export', args: '' } as Parameters<typeof $.command.run>[0])
  expect(out.text).toContain('report-')
  expect(written.length).toBe(1)
})
