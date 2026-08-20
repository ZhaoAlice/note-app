import type { DesktopApi } from './types'

declare global {
  interface Window {
    shijianDesktop?: DesktopApi
  }
}

export {}
