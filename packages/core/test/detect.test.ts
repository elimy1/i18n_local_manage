import { describe, expect, it } from './_expect.js'
import { classify } from '../src/detect.js'
import type { Candidate, CandidateKind } from '../src/types.js'

function cand(kind: CandidateKind, value: string, meta: Record<string, unknown> = {}): Candidate {
  return { id: 'x', file: 'src/a.tsx', start: 0, end: value.length, line: 1, column: 1, kind, value, raw: value, lang: 'tsx', meta }
}

describe('classify', () => {
  it('accepts Chinese UI copy', () => {
    const r = classify(cand('jsx-text', '请选择审批人'))
    expect(r.translatable).toBe(true)
    expect(r.reasons).toContain('+cjk')
  })

  it('rejects tailwind class lists', () => {
    const r = classify(cand('string-literal', 'flex items-center justify-between p-4'))
    expect(r.translatable).toBe(false)
    expect(r.reasons).toContain('-class-list')
  })

  it('rejects identifiers, urls and bare numbers', () => {
    expect(classify(cand('string-literal', 'accessToken')).translatable).toBe(false)
    expect(classify(cand('string-literal', 'https://example.com/a')).translatable).toBe(false)
    expect(classify(cand('string-literal', '1200')).translatable).toBe(false)
  })

  it('rejects strings already wrapped in t()', () => {
    const r = classify(cand('call-arg', '保存成功', { callee: 't', wrapped: true }))
    expect(r.translatable).toBe(false)
    expect(r.reasons).toContain('-already-i18n')
  })

  it('accepts English sentences but not single words', () => {
    expect(classify(cand('jsx-text', 'Delete this workspace')).translatable).toBe(true)
    expect(classify(cand('jsx-text', 'Delete')).translatable).toBe(false)
  })

  it('treats message API args as copy', () => {
    expect(classify(cand('call-arg', '保存成功', { callee: 'message.success' })).translatable).toBe(true)
  })
})
