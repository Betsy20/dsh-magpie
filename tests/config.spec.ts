import { describe, expect, it } from 'vitest'

import { Config, DEFAULT_OPTIONS, resolveOptions } from '../src/config.js'

/**
 * 走一遍 cordis 的真实路径：`Config['~standard'].validate()` 会把
 * `.volatile()` 字段包成 `{ get(): T }` 引用。
 *
 * 返回值的类型不是 `MagpieOptions`，所以这里只取 `value` 再交给
 * `resolveOptions` —— 这正是 `src/index.ts` 里 `apply(ctx, config)` 的
 * 等价形态。
 */
function throughSchema(input: Record<string, unknown>): unknown {
  const standard = Config['~standard'] as unknown as {
    validate(value: unknown): { value: unknown }
  }
  return standard.validate(input).value
}

describe('resolveOptions', () => {
  it('空配置返回默认值', () => {
    expect(resolveOptions(undefined)).toEqual(DEFAULT_OPTIONS)
  })

  it('非对象配置被忽略', () => {
    expect(resolveOptions('nope')).toEqual(DEFAULT_OPTIONS)
    expect(resolveOptions(42)).toEqual(DEFAULT_OPTIONS)
    expect(resolveOptions(null)).toEqual(DEFAULT_OPTIONS)
  })

  it('baseURL 去掉尾部斜杠', () => {
    expect(resolveOptions({ baseURL: 'http://example.com:9999/' }).baseURL).toBe(
      'http://example.com:9999',
    )
    expect(resolveOptions({ baseURL: 'http://example.com:9999///' }).baseURL).toBe(
      'http://example.com:9999',
    )
  })

  it('字符串字段会 trim，空白串回退默认值', () => {
    expect(resolveOptions({ webHost: '  0.0.0.0  ' }).webHost).toBe('0.0.0.0')
    expect(resolveOptions({ webHost: '   ' }).webHost).toBe(DEFAULT_OPTIONS.webHost)
  })

  it('非法类型回退默认值', () => {
    const options = resolveOptions({ webPort: 'not-a-number', autoStartGateway: 'yes' })
    expect(options.webPort).toBe(DEFAULT_OPTIONS.webPort)
    expect(options.autoStartGateway).toBe(DEFAULT_OPTIONS.autoStartGateway)
  })

  it('端口越界回退默认值', () => {
    expect(resolveOptions({ webPort: -1 }).webPort).toBe(DEFAULT_OPTIONS.webPort)
    expect(resolveOptions({ webPort: 0 }).webPort).toBe(DEFAULT_OPTIONS.webPort)
    // 上界：`findFreePort()` 在 > 65535 时会直接 break，错误信息还不可读。
    expect(resolveOptions({ webPort: 70_000 }).webPort).toBe(DEFAULT_OPTIONS.webPort)
    // 小数不是合法端口。
    expect(resolveOptions({ webPort: 1.5 }).webPort).toBe(DEFAULT_OPTIONS.webPort)
    // 边界值必须被接受。
    expect(resolveOptions({ webPort: 1 }).webPort).toBe(1)
    expect(resolveOptions({ webPort: 65_535 }).webPort).toBe(65_535)
  })

  it('合法值被采用', () => {
    const options = resolveOptions({
      webPort: 4000,
      autoStartGateway: false,
      webKey: 'a'.repeat(20),
    })
    expect(options.webPort).toBe(4000)
    expect(options.autoStartGateway).toBe(false)
    expect(options.webKey).toBe('a'.repeat(20))
  })

  it('proxyPort 默认值落在 magpie 自己的扫描区间之外', () => {
    // ⚠️ 这条是**回归测试**：默认值一度是 3490，而 `magpie serve` 在端口
    //    被占时会自己向上找 24 个（3480–3503）。3490 落在里面，用户机器
    //    上只要有几个 magpie 实例就会把代理端口抢走。
    const { proxyPort, webPort } = DEFAULT_OPTIONS
    expect(proxyPort).toBe(3590)
    expect(proxyPort).toBeGreaterThanOrEqual(webPort + 24)
  })

  it('proxyPort 合法值被采用、非法值回退', () => {
    expect(resolveOptions({ proxyPort: 4000 }).proxyPort).toBe(4000)
    expect(resolveOptions({ proxyPort: 1 }).proxyPort).toBe(1)
    expect(resolveOptions({ proxyPort: 65_535 }).proxyPort).toBe(65_535)
    // 越界 / 小数 / 类型不对都回退默认值。
    expect(resolveOptions({ proxyPort: 0 }).proxyPort).toBe(DEFAULT_OPTIONS.proxyPort)
    expect(resolveOptions({ proxyPort: -1 }).proxyPort).toBe(DEFAULT_OPTIONS.proxyPort)
    expect(resolveOptions({ proxyPort: 70_000 }).proxyPort).toBe(DEFAULT_OPTIONS.proxyPort)
    expect(resolveOptions({ proxyPort: 1.5 }).proxyPort).toBe(DEFAULT_OPTIONS.proxyPort)
    expect(resolveOptions({ proxyPort: '3490' }).proxyPort).toBe(DEFAULT_OPTIONS.proxyPort)
  })

  it('proxyPort 经 Volatile 解包后不丢', () => {
    const options = resolveOptions(throughSchema({ proxyPort: 4123 }))
    expect(options.proxyPort).toBe(4123)
  })

  it('返回的对象被冻结', () => {
    expect(Object.isFrozen(resolveOptions(undefined))).toBe(true)
  })
})

describe('resolveOptions 解包 schemastery 的 Volatile', () => {
  it('经 Config 校验后的每个字段都是 Volatile 引用', () => {
    const validated = throughSchema({ webPort: 4000, webEnabled: false })
    expect(validated).not.toBeNull()
    expect(typeof validated).toBe('object')
    // 关键前提：如果 schemastery 哪天不再包 Volatile，这条会先失败，
    // 提醒我们去删掉 `read()` 里的解包分支。
    const field = (validated as Record<string, unknown>)['webPort']
    expect(typeof field).toBe('object')
    expect(field).toHaveProperty('get')
  })

  it('用户配置在 Volatile 形态下不会丢', () => {
    const validated = throughSchema({
      baseURL: 'http://example.com:9999/',
      webPort: 4000,
      webEnabled: false,
      autoStartGateway: false,
      autoDownloadMagpie: false,
      magpieBinary: '/custom/path/magpie.exe',
      webHost: '0.0.0.0',
      proxyPort: 4123,
      webKey: 'a'.repeat(20),
    })

    const options = resolveOptions(validated)
    expect(options.baseURL).toBe('http://example.com:9999')
    expect(options.webPort).toBe(4000)
    expect(options.webEnabled).toBe(false)
    expect(options.autoStartGateway).toBe(false)
    expect(options.autoDownloadMagpie).toBe(false)
    expect(options.magpieBinary).toBe('/custom/path/magpie.exe')
    expect(options.webHost).toBe('0.0.0.0')
    expect(options.proxyPort).toBe(4123)
    expect(options.webKey).toBe('a'.repeat(20))
  })

  it('Volatile 与裸对象混用时两者都认', () => {
    const validated = throughSchema({ webPort: 4000 })
    const mixed = { ...(validated as Record<string, unknown>), webEnabled: false }
    const options = resolveOptions(mixed)
    expect(options.webPort).toBe(4000)
    expect(options.webEnabled).toBe(false)
  })
})
