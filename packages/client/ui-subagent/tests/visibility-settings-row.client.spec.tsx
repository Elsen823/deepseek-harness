// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { VisibilitySettingsRow, type VisibilitySettingsRowProps } from '../src/client/VisibilitySettingsRow.tsx'
import { zh } from '../src/client/locales.ts'

const t: VisibilitySettingsRowProps['t'] = makeTranslate(zh)

afterEach(() => { cleanup() })

describe('VisibilitySettingsRow', () => {
  it('renders the durable preference and toggles it', () => {
    const setHideInactive = vi.fn()
    const settings = { hideInactive: true, inactiveAfterMinutes: 60 }
    const useVisibility = <T,>(select: (value: typeof settings) => T): T => select(settings)

    render(<VisibilitySettingsRow {...({ useVisibility, setHideInactive, t } as VisibilitySettingsRowProps)} />)

    const toggle = screen.getByRole('switch', { name: /已开启/ })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('隐藏超过 60 分钟没有活动且当前未运行的子代理。')).not.toBeNull()
    fireEvent.click(toggle)
    expect(setHideInactive).toHaveBeenCalledWith(false)
  })
})
