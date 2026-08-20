import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useReaderPageTurn } from '../components/reader/page-turn'

function PageTurnHarness({ enabled = true }: { enabled?: boolean }) {
  const [page, setPage] = useState(2)
  const controls = useReaderPageTurn({ enabled, onTurn: (direction) => setPage((value) => value + direction) })
  return (
    <section data-testid="reader" onWheel={controls.onWheel}>
      <output>{page}</output>
      <input aria-label="页码输入" />
    </section>
  )
}

describe('reader page turn controls', () => {
  it('使用四个方向键和滚轮翻页', () => {
    render(<PageTurnHarness />)

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('3')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(screen.getByText('2')).toBeInTheDocument()
    fireEvent.wheel(screen.getByTestId('reader'), { deltaY: 80 })
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('编辑输入框或使用连续滚动模式时不拦截按键', () => {
    const view = render(<PageTurnHarness />)
    const input = screen.getByLabelText('页码输入')
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(screen.getByText('2')).toBeInTheDocument()

    view.rerender(<PageTurnHarness enabled={false} />)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.wheel(screen.getByTestId('reader'), { deltaY: 80 })
    expect(screen.getByText('2')).toBeInTheDocument()
  })
})
