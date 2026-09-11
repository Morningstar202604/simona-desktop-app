import { describe, expect, it } from 'bun:test'
import {
  hasSafeHeredocSubstitution,
  stripSafeHeredocSubstitutions,
} from '../src/tools/BashTool/bashSecurity.js'

describe('stripSafeHeredocSubstitutions', () => {
  it('returns null when there is no heredoc inside $()', () => {
    expect(stripSafeHeredocSubstitutions('ls -la')).toBeNull()
    expect(stripSafeHeredocSubstitutions('echo $(date)')).toBeNull()
    expect(stripSafeHeredocSubstitutions('cat <<EOF\nhello\nEOF')).toBeNull()
  })

  it('strips a safe quoted-delimiter heredoc inside $()', () => {
    const cmd = "git commit -m \"$(cat <<'EOF'\nmy message\nEOF\n)\""
    const stripped = stripSafeHeredocSubstitutions(cmd)
    expect(stripped).not.toBeNull()
    expect(stripped).toContain('git commit')
    expect(stripped).not.toContain('EOF')
    expect(stripped).not.toContain('cat')
  })

  it('strips an escaped-delimiter heredoc inside $()', () => {
    const cmd = 'git commit -m "$(cat <<\\EOF\nmy message\nEOF\n)"'
    const stripped = stripSafeHeredocSubstitutions(cmd)
    expect(stripped).not.toBeNull()
    expect(stripped).not.toContain('EOF')
  })

  it('ignores heredocs with unquoted delimiters (expansion risk)', () => {
    const cmd = 'git commit -m "$(cat <<EOF\n$HOME\nEOF\n)"'
    expect(stripSafeHeredocSubstitutions(cmd)).toBeNull()
  })

  it('ignores escaped \\$( sequences', () => {
    const cmd = "echo \\$(cat <<'EOF'\nx\nEOF\n)"
    expect(stripSafeHeredocSubstitutions(cmd)).toBeNull()
  })
})

describe('hasSafeHeredocSubstitution', () => {
  it('detects safe heredoc substitutions', () => {
    expect(
      hasSafeHeredocSubstitution("git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\""),
    ).toBe(true)
  })

  it('rejects plain commands and unsafe variants', () => {
    expect(hasSafeHeredocSubstitution('ls')).toBe(false)
    expect(
      hasSafeHeredocSubstitution('git commit -m "$(cat <<EOF\nmsg\nEOF\n)"'),
    ).toBe(false)
  })
})
