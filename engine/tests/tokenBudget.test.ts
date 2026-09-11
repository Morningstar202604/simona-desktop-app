import { describe, expect, it } from 'bun:test'
import {
  checkTokenBudget,
  createBudgetTracker,
} from '../src/query/tokenBudget.js'
import { getBudgetContinuationMessage } from '../src/utils/tokenBudget.js'

describe('createBudgetTracker', () => {
  it('initializes with zeroed counters', () => {
    const t = createBudgetTracker()
    expect(t.continuationCount).toBe(0)
    expect(t.lastDeltaTokens).toBe(0)
    expect(t.lastGlobalTurnTokens).toBe(0)
    expect(t.startedAt).toBeGreaterThan(0)
  })
})

describe('checkTokenBudget', () => {
  it('stops immediately for subagents (agentId set)', () => {
    const t = createBudgetTracker()
    const d = checkTokenBudget(t, 'agent-1', 100000, 1000)
    expect(d.action).toBe('stop')
    if (d.action === 'stop') expect(d.completionEvent).toBeNull()
  })

  it('stops when budget is null or non-positive', () => {
    const t = createBudgetTracker()
    expect(checkTokenBudget(t, undefined, null, 1000).action).toBe('stop')
    expect(checkTokenBudget(t, undefined, 0, 1000).action).toBe('stop')
    expect(checkTokenBudget(t, undefined, -5, 1000).action).toBe('stop')
  })

  it('continues below the 90% completion threshold', () => {
    const t = createBudgetTracker()
    const d = checkTokenBudget(t, undefined, 100000, 50000)
    expect(d.action).toBe('continue')
    if (d.action === 'continue') {
      expect(d.pct).toBe(50)
      expect(d.continuationCount).toBe(1)
      expect(d.nudgeMessage).toContain('50%')
    }
    expect(t.lastGlobalTurnTokens).toBe(50000)
  })

  it('stops at or above the 90% completion threshold', () => {
    const t = createBudgetTracker()
    const d = checkTokenBudget(t, undefined, 100000, 95000)
    expect(d.action).toBe('stop')
    if (d.action === 'stop' && d.completionEvent) {
      expect(d.completionEvent.pct).toBe(95)
      expect(d.completionEvent.diminishingReturns).toBe(false)
    }
  })

  it('stops on diminishing returns after >=3 continuations', () => {
    const t = createBudgetTracker()
    // 3 continuations, each advancing < DIMINISHING_THRESHOLD (500) tokens
    checkTokenBudget(t, undefined, 1000000, 10000)
    checkTokenBudget(t, undefined, 1000000, 10100)
    checkTokenBudget(t, undefined, 1000000, 10200)
    const d = checkTokenBudget(t, undefined, 1000000, 10300)
    expect(d.action).toBe('stop')
    if (d.action === 'stop' && d.completionEvent) {
      expect(d.completionEvent.diminishingReturns).toBe(true)
    }
  })
})

describe('getBudgetContinuationMessage', () => {
  it('includes pct and formatted token counts', () => {
    const msg = getBudgetContinuationMessage(50, 50000, 100000)
    expect(msg).toContain('50%')
    expect(msg).toContain('50,000')
    expect(msg).toContain('100,000')
    expect(msg).toContain('do not summarize')
  })
})
