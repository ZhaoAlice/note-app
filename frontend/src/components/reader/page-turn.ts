import { useCallback, useEffect, useRef, type WheelEvent as ReactWheelEvent } from 'react'

export type PageTurnDirection = -1 | 1

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, select, button, [contenteditable="true"], [role="textbox"]'))
}

export function pageTurnDirectionForKey(event: KeyboardEvent): PageTurnDirection | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isEditingTarget(event.target)) return null
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return -1
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return 1
  return null
}

export function useReaderPageTurn({
  enabled,
  onTurn,
}: {
  enabled: boolean
  onTurn: (direction: PageTurnDirection) => void
}) {
  const onTurnRef = useRef(onTurn)
  const wheelAmountRef = useRef(0)
  const lastWheelAtRef = useRef(0)
  const wheelLockedUntilRef = useRef(0)
  onTurnRef.current = onTurn

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (!enabled) return
    const direction = pageTurnDirectionForKey(event)
    if (direction === null) return
    event.preventDefault()
    onTurnRef.current(direction)
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, onKeyDown])

  useEffect(() => {
    if (enabled) return
    wheelAmountRef.current = 0
    lastWheelAtRef.current = 0
    wheelLockedUntilRef.current = 0
  }, [enabled])

  const handleWheel = useCallback((event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'preventDefault' | 'target'>) => {
    if (!enabled || isEditingTarget(event.target)) return
    const amount = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (!amount) return
    event.preventDefault()

    const now = Date.now()
    if (now < wheelLockedUntilRef.current) return
    if (now - lastWheelAtRef.current > 180 || Math.sign(wheelAmountRef.current) !== Math.sign(amount)) {
      wheelAmountRef.current = 0
    }
    lastWheelAtRef.current = now
    wheelAmountRef.current += amount
    if (Math.abs(wheelAmountRef.current) < 40) return

    const direction: PageTurnDirection = wheelAmountRef.current < 0 ? -1 : 1
    wheelAmountRef.current = 0
    wheelLockedUntilRef.current = now + 320
    onTurnRef.current(direction)
  }, [enabled])

  const onWheel = useCallback((event: ReactWheelEvent<HTMLElement>) => handleWheel(event), [handleWheel])

  return { onKeyDown, onNativeWheel: handleWheel, onWheel }
}
