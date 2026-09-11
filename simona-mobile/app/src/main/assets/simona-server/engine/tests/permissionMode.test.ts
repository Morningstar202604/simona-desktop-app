import { describe, expect, it } from 'bun:test'
import {
  isExternalPermissionMode,
  permissionModeFromString,
  toExternalPermissionMode,
} from '../src/utils/permissions/PermissionMode.js'
import {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
} from '../src/types/permissions.js'

describe('permissionModeFromString', () => {
  it('round-trips every declared permission mode', () => {
    for (const mode of PERMISSION_MODES) {
      expect(permissionModeFromString(mode)).toBe(mode)
    }
  })

  it('falls back to "default" for unknown strings', () => {
    expect(permissionModeFromString('nonsense')).toBe('default')
    expect(permissionModeFromString('')).toBe('default')
    expect(permissionModeFromString('PLAN')).toBe('default') // case-sensitive
  })
})

describe('external permission mode mapping', () => {
  it('maps every mode to a declared external mode', () => {
    for (const mode of PERMISSION_MODES) {
      const external = toExternalPermissionMode(mode)
      expect(EXTERNAL_PERMISSION_MODES).toContain(external)
    }
  })

  it('treats every mode as external for non-ant users', () => {
    const prev = process.env.USER_TYPE
    delete process.env.USER_TYPE
    try {
      for (const mode of PERMISSION_MODES) {
        expect(isExternalPermissionMode(mode)).toBe(true)
      }
    } finally {
      if (prev === undefined) delete process.env.USER_TYPE
      else process.env.USER_TYPE = prev
    }
  })

  it('hides auto/bubble from external surface for ant users', () => {
    const prev = process.env.USER_TYPE
    process.env.USER_TYPE = 'ant'
    try {
      expect(isExternalPermissionMode('auto')).toBe(false)
      expect(isExternalPermissionMode('bubble')).toBe(false)
      expect(isExternalPermissionMode('default')).toBe(true)
      expect(isExternalPermissionMode('plan')).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.USER_TYPE
      else process.env.USER_TYPE = prev
    }
  })
})
