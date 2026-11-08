import { describe, expect, it } from 'vitest'

import type { MagpieWebBridgeOptions, WebBridgeLogger } from '../src/web-bridge.js'
import {
  MagpieWebBridge,
  dockWindowUrl,
  mainWindowUrl,
  restartDelay,
} from '../src/web-bridge.js'

/**
 * 收集日志的假 logger。
 *
 * 桥在启动失败路径上会 `warn()` 好几条 —— 直接打到 stdout 会把 vitest 的
 * 输出淹掉，所以这里先收着，需要时再断言。
 */
interface SilentLogger extends WebBridgeLogger {
  readonly lines: string[]
}

function silentLogger(): SilentLogger {
  const lines: string[] = []
  return {
    lines,
    debug(message: string): void {
      lines.push(`debug ${message}`)
    },
    warn(message: string): void {
      lines.push(`warn ${message}`)
    },
  }
}

/**
 * 一个**肯定不存在**的可执行文件路径。
 *
 * 用来触发 `spawn()` 的 `ENOENT` —— 这是「宿主崩溃」那条 P1 的回归入口。
 */
const MISSING_BINARY =
  process.platform === 'win32'
    ? 'C:\\definitely-no-such-magpie-build-xyz\\magpie.exe'
    : '/definitely/no/such/magpie-build-xyz/magpie'

/**
 * 构造一份能跑起来的最简选项。
 *
 * 端口取一个 IANA 动态端口区间里的高位值，避开 CI 上常见的 3000/8080。
 */
function bridgeOptions(overrides: Partial<MagpieWebBridgeOptions> = {}): MagpieWebBridgeOptions {
  return {
    binary: MISSING_BINARY,
    key: 'a'.repeat(20),
    host: '127.0.0.1',
    preferredPort: 45_678,
    logger: silentLogger(),
    ...overrides,
  }
}

describe('mainWindowUrl / dockWindowUrl', () => {
  it('回环地址原样拼接', () => {
    expect(mainWindowUrl('127.0.0.1', 3590)).toBe('http://127.0.0.1:3590/')
    expect(dockWindowUrl('127.0.0.1', 3590)).toBe('http://127.0.0.1:3590/?mode=panel')
  })

  it('通配绑定地址换成回环地址', () => {
    // `0.0.0.0` / `::` 能 listen 但不能用来建连，必须换成回环。
    expect(mainWindowUrl('0.0.0.0', 3590)).toBe('http://127.0.0.1:3590/')
    expect(mainWindowUrl('', 3590)).toBe('http://127.0.0.1:3590/')
    expect(mainWindowUrl('   ', 3590)).toBe('http://127.0.0.1:3590/')
    expect(mainWindowUrl('::', 3590)).toBe('http://[::1]:3590/')
  })

  it('IPv6 字面量必须带方括号', () => {
    // ⚠️ 回归：裸 `::1` 拼进 URL 会 `ERR_INVALID_URL`，iframe 直接白屏。
    expect(mainWindowUrl('::1', 3590)).toBe('http://[::1]:3590/')
    expect(dockWindowUrl('::1', 3590)).toBe('http://[::1]:3590/?mode=panel')
    expect(() => new URL(mainWindowUrl('::1', 3590))).not.toThrow()
    expect(() => new URL(dockWindowUrl('::1', 3590))).not.toThrow()
  })

  it('主机名原样透传', () => {
    expect(mainWindowUrl('localhost', 3590)).toBe('http://localhost:3590/')
    expect(mainWindowUrl('10.0.0.5', 3590)).toBe('http://10.0.0.5:3590/')
  })
})

describe('restartDelay', () => {
  it('指数退避：1s → 2s → 4s → 8s → 15s 封顶', () => {
    expect([1, 2, 3, 4, 5].map(restartDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000])
    // 超过 5 次不再增长，避免「重启风暴」把等待拖到分钟级。
    expect(restartDelay(6)).toBe(15_000)
    expect(restartDelay(Number.MAX_SAFE_INTEGER)).toBe(15_000)
  })

  it('非法输入兜底到第一次的等待时间', () => {
    // `2 ** -1` 是 0.5，不兜底会算出一个 500ms 的「第 0 次」。
    expect(restartDelay(0)).toBe(1_000)
    expect(restartDelay(-3)).toBe(1_000)
  })
})

describe('MagpieWebBridge 启动失败', () => {
  it('binary 缺失时抛出带安装指引的错误', async () => {
    const bridge = new MagpieWebBridge(bridgeOptions({ binary: undefined }))
    try {
      await expect(bridge.ensure()).rejects.toThrow('找不到 magpie 可执行文件')
    } finally {
      bridge.dispose()
    }
  })

  it('MAGPIE_WEB_KEY 不合法时提前报错', async () => {
    // 校验必须在 `spawn()` **之前** —— 否则会先拉起一个注定被 magpie 拒绝的
    // 子进程，再抛错，副作用不可回滚。
    const bridge = new MagpieWebBridge(bridgeOptions({ key: 'short' }))
    try {
      await expect(bridge.ensure()).rejects.toThrow('MAGPIE_WEB_KEY 不合法')
    } finally {
      bridge.dispose()
    }
  })

  it('二进制不存在时 reject 而不是让宿主崩溃', async () => {
    // ⚠️ 这是 P1 的回归：`spawn()` 失败会异步发 `error` 事件，没有监听器
    //    时 Node 走 `Unhandled 'error' event` 直接把整个进程带走（实测
    //    exit 1）。在 vitest 里就是「worker 崩了、没有汇总行」。
    const logger = silentLogger()
    const bridge = new MagpieWebBridge(bridgeOptions({ logger }))
    try {
      await expect(bridge.ensure()).rejects.toThrow()
      // 失败原因必须落到日志里，否则用户只能看到白屏。
      expect(logger.lines.length).toBeGreaterThan(0)
    } finally {
      bridge.dispose()
    }
  }, 10_000)

  it('dispose 之后 ensure 立刻拒绝', async () => {
    const bridge = new MagpieWebBridge(bridgeOptions())
    bridge.dispose()
    await expect(bridge.ensure()).rejects.toThrow('Web 桥已卸载')
  })

  it('dispose 是幂等的', () => {
    const bridge = new MagpieWebBridge(bridgeOptions())
    expect(() => {
      bridge.dispose()
      bridge.dispose()
    }).not.toThrow()
  })

  it('并发 ensure 共享同一次启动，不会各起一个进程', async () => {
    // 旧实现先 `discardHandle()` 再判 `starting` —— 两个面板同时挂载时，
    // 第二个调用会把第一个正在建立的子进程清掉。
    const bridge = new MagpieWebBridge(bridgeOptions({ binary: undefined }))
    try {
      const results = await Promise.allSettled([bridge.ensure(), bridge.ensure()])
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
      // 两次都必须报同一个「找不到二进制」，说明走的是同一条启动路径，
      // 而不是第一个 reject 之后又重新 Spawn 了一次。
      for (const result of results) {
        expect(result.status === 'rejected' ? String(result.reason) : '').toContain(
          '找不到 magpie 可执行文件',
        )
      }
    } finally {
      bridge.dispose()
    }
  })
})
