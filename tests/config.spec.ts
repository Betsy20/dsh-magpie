import { describe, expect, it } from 'vitest'

import { DEFAULT_OPTIONS, resolveOptions } from '../src/config.js'

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

  it('负数与零回退默认值', () => {
    expect(resolveOptions({ webPort: -1 }).webPort).toBe(DEFAULT_OPTIONS.webPort)
    expect(resolveOptions({ webPort: 0 }).webPort).toBe(DEFAULT_OPTIONS.webPort)
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

  it('返回的对象被冻结', () => {
    expect(Object.isFrozen(resolveOptions(undefined))).toBe(true)
  })
})
