import { describe, expect, it } from 'vitest'
import { squirrelLifecycleEvent } from './squirrel'

describe('squirrelLifecycleEvent', () => {
  it.each([
    '--squirrel-install',
    '--squirrel-updated',
    '--squirrel-uninstall',
    '--squirrel-obsolete',
  ])('识别需要处理后退出的生命周期事件 %s', (event) => {
    expect(squirrelLifecycleEvent(['Shijian.exe', event, '0.2.0-beta.1'])).toBe(event)
  })

  it('首次安装自动启动时继续进入正常应用流程', () => {
    expect(squirrelLifecycleEvent(['Shijian.exe', '--squirrel-firstrun'])).toBeNull()
  })

  it('普通启动时不进入安装事件分支', () => {
    expect(squirrelLifecycleEvent(['Shijian.exe'])).toBeNull()
  })
})
