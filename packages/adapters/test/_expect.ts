// A minimal vitest-compatible surface on top of node:test + node:assert/strict.
//
// Why not vitest: this workspace is installed by pnpm inside a sandbox that
// cannot spawn child processes with piped stdio, and vite/esbuild both spawn
// one (`net use` probing, esbuild service). The compile-then-run route keeps
// the suite dependency-free and still exercises the real emitted JS.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

export { describe, it }

type Fn = () => void

function attempt(fn: Fn): Error | null {
  try {
    fn()
    return null
  } catch (err) {
    return err as Error
  }
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (v instanceof Set) return `Set(${[...v].map(fmt).join(', ')})`
  try {
    const s = JSON.stringify(v)
    if (s !== undefined) return s.length > 160 ? `${s.slice(0, 157)}…` : s
  } catch {
    /* circular */
  }
  return String(v)
}

class Assertion {
  constructor(
    private readonly actual: unknown,
    private readonly negated = false,
  ) {}

  get not(): Assertion {
    return new Assertion(this.actual, !this.negated)
  }

  private check(desc: string, fn: Fn) {
    const err = attempt(fn)
    if (this.negated ? err === null : err !== null) {
      const detail = err ? ` (${err.message.split('\n')[0]})` : ''
      throw new Error(`expected ${fmt(this.actual)}${this.negated ? ' not ' : ' '}${desc}${detail}`)
    }
  }

  toBe(expected: unknown) {
    this.check(`to be ${fmt(expected)}`, () => assert.ok(Object.is(this.actual, expected)))
  }

  toEqual(expected: unknown) {
    this.check(`to equal ${fmt(expected)}`, () => assert.deepStrictEqual(this.actual, expected))
  }

  toContain(needle: unknown) {
    this.check(`to contain ${fmt(needle)}`, () => {
      if (typeof this.actual === 'string') assert.ok(this.actual.includes(String(needle)))
      else assert.ok((this.actual as readonly unknown[]).includes(needle))
    })
  }

  toMatch(re: RegExp) {
    this.check(`to match ${re}`, () => assert.match(String(this.actual), re))
  }

  toHaveLength(n: number) {
    this.check(`to have length ${n}`, () =>
      assert.equal((this.actual as { length: number }).length, n),
    )
  }

  toBeUndefined() {
    this.check('to be undefined', () => assert.equal(this.actual, undefined))
  }

  toBeNull() {
    this.check('to be null', () => assert.equal(this.actual, null))
  }

  toBeTruthy() {
    this.check('to be truthy', () => assert.ok(this.actual))
  }

  toBeFalsy() {
    this.check('to be falsy', () => assert.ok(!this.actual))
  }

  toBeGreaterThan(n: number) {
    this.check(`to be greater than ${n}`, () =>
      assert.ok((this.actual as number) > n, `${fmt(this.actual)} > ${n}`),
    )
  }

  toBeCloseTo(n: number, digits = 2) {
    this.check(`to be close to ${n}`, () =>
      assert.ok(Math.abs((this.actual as number) - n) < Math.pow(10, -digits) / 2),
    )
  }
}

export function expect(actual: unknown): Assertion {
  return new Assertion(actual)
}
