/**
 * magpie 二进制自动下载。
 *
 * ## 为什么插件要自己下 magpie
 *
 * 用户的原话是「应该是我安装插件就能用，不用管网关」。换句话说：
 * **装插件**就是全部的安装动作 —— 不该再要求用户去 GitHub 下个 69 MB 的
 * 可执行文件、解压、加进 PATH。
 *
 * 所以插件在第一次需要二进制时（`apply()` 里后台触发）会：
 *
 * 1. 先按 {@link resolveMagpieBinary} 的四个来源找一遍（配置 → 插件自带 →
 *    系统安装 → PATH）；
 * 2. 一个都没有、且 `autoDownloadMagpie` 开着，就从 GitHub Releases 下
 *    `magpie-cli-<os>-<arch>` 到 `~/.dsh/magpie/bin/`。
 *
 * ## 为什么不用 `curl`
 *
 * Windows 上 `curl` 的 schannel 后端对 GitHub Release 的 302 跳转偶发
 * `schannel: server closed abruptly (missing close_notify)` —— 只下到
 * 31 MB（应该 69.5 MB）就断，而且**退出码仍然是 0**。用 `curl` 会得到
 * 一个「看起来成功」的半截文件。
 *
 * Node 自带的 `fetch`（undici）没有这个问题。
 *
 * ## 为什么先写 `.part` 再 rename
 *
 * 下载中断时会留下一个 `.part` 文件，而不是一个**看起来能用但实际被截断**
 * 的可执行文件。后者在 `spawn` 时会报各种莫名其妙的错（Windows 上是
 * `%1 不是有效的 Win32 应用程序`），排查成本极高。
 *
 * @module dsh-magpie/download
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { BIN_DIR, managedBinaryPath, releaseAssetName } from './binary.js'

/** GitHub 仓库（magpie 的官方地址）。 */
const REPO = 'yetone/magpie'

/** 下载超时。69 MB 在慢网下要几分钟，给足余量。 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

/** 小于这个大小的一律认为不是完整二进制（真实产物 ~69 MB）。 */
const MIN_BINARY_BYTES = 1024 * 1024

/** 日志出口。 */
export interface DownloadLogger {
  debug(message: string): void
  warn(message: string): void
}

/** {@link ensureMagpieBinary} 的入参。 */
export interface EnsureBinaryOptions {
  /** 日志出口。 */
  readonly logger: DownloadLogger
  /** 指定版本（`v0.12.6` 这种）；默认问 GitHub 要最新。 */
  readonly version?: string
  /** 强制重下（忽略已有文件）。 */
  readonly force?: boolean
  /**
   * 取消信号。
   *
   * 插件卸载时必须能中断下载 —— 69 MB 在慢网下要几分钟，不中断的话
   * DSH 退出后还有一个进程在往 `~/.dsh/magpie/bin/` 里写文件。
   */
  readonly signal?: AbortSignal
}

/** {@link ensureMagpieBinary} 的产出。 */
export interface EnsureBinaryResult {
  /** 二进制绝对路径。 */
  readonly path: string
  /** 版本号（拿不到时为 `undefined`）。 */
  readonly version: string | undefined
  /** 这次是否真的下载了。 */
  readonly downloaded: boolean
}

/** GitHub Release 里关心的字段。 */
interface ReleaseBody {
  readonly tag_name?: unknown
  readonly assets?: unknown
}

/** 单个资产。 */
interface ReleaseAsset {
  readonly name?: unknown
  readonly browser_download_url?: unknown
  readonly size?: unknown
}

/**
 * 二进制是否已经就位。
 *
 * 判据是「存在 + 是文件 + 大于 1 MB」。单纯 `exists` 不够 —— 上一次下载
 * 中断留下的 0 字节文件同样存在。
 */
export async function hasBinary(): Promise<boolean> {
  try {
    const info = await stat(managedBinaryPath())
    return info.isFile() && info.size > MIN_BINARY_BYTES
  } catch {
    return false
  }
}

/** 读已安装版本号（`version.json`），没有就返回 `undefined`。 */
export async function installedVersion(): Promise<string | undefined> {
  try {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(join(BIN_DIR, 'version.json'), 'utf8')
    const parsed = JSON.parse(text) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 问 GitHub 要 magpie 的最新 release。
 *
 * @returns 版本号与资产表；网络/解析失败返回 `undefined`（**不抛** ——
 *          调用方要么降级要么自己决定怎么报错）。
 */
async function resolveLatestRelease(
  logger: DownloadLogger,
  signal?: AbortSignal,
): Promise<{ version: string; assets: readonly ReleaseAsset[] } | undefined> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-magpie',
      },
      // 同时受「30 秒超时」和「插件卸载」两个信号控制 —— `AbortSignal.any`
      // 任一触发就中断（Node 20+ 提供）。
      signal:
        signal === undefined
          ? AbortSignal.timeout(30_000)
          : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) {
      logger.warn(`[magpie] 查询最新版本失败：HTTP ${String(response.status)}`)
      return undefined
    }
    const body = (await response.json()) as ReleaseBody
    if (typeof body.tag_name !== 'string') {
      logger.warn('[magpie] 最新版本响应里没有 tag_name')
      return undefined
    }
    return {
      version: body.tag_name,
      assets: Array.isArray(body.assets) ? (body.assets as ReleaseAsset[]) : [],
    }
  } catch (error) {
    logger.warn(
      `[magpie] 查询最新版本出错：${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

/** 从资产表里挑出当前平台的下载地址。 */
function pickAsset(
  assets: readonly ReleaseAsset[],
  assetName: string,
): { url: string; name: string } | undefined {
  for (const asset of assets) {
    if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') continue
    if (asset.name === assetName) {
      return { url: asset.browser_download_url, name: asset.name }
    }
  }
  return undefined
}

/** 把响应体流式写到磁盘，返回字节数与 sha256。 */
async function writeStream(
  response: Response,
  destination: string,
  logger: DownloadLogger,
): Promise<{ bytes: number; sha256: string }> {
  if (response.body === null) throw new Error('下载响应没有 body')

  const total = Number(response.headers.get('content-length') ?? '0')
  const hash = createHash('sha256')
  const out = createWriteStream(destination)
  let bytes = 0
  let lastLogged = 0

  // 用 `Transform` 做旁路统计，再用 `pipeline` 串起来 —— 不要手写
  // `write` + `drain` + `end` 那套，出错过一次流就再也关不干净，
  // 而且会把真正的错误（比如网络中断）替换成 `ERR_STREAM_WRITE_AFTER_END`。
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      bytes += chunk.byteLength
      hash.update(chunk)
      // 每 25% 打一条，避免日志被刷屏。
      if (total > 0) {
        const percent = Math.floor((bytes / total) * 4) * 25
        if (percent > lastLogged) {
          lastLogged = percent
          logger.debug(
            `[magpie] 下载中 ${(bytes / 1024 / 1024).toFixed(1)} MB / ` +
              `${(total / 1024 / 1024).toFixed(1)} MB（${String(percent)}%）`,
          )
        }
      }
      callback(null, chunk)
    },
  })

  // `Response.body` 是 web `ReadableStream`，`pipeline` 只认 Node 流。
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), counter, out)
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * 确保 magpie 二进制存在；不存在就下载。
 *
 * 幂等 —— 已经有完整文件时直接返回路径，不发任何网络请求。
 *
 * @throws 平台不支持、GitHub 不可达、下载不完整时抛错（错误信息带可操作建议）。
 */
export async function ensureMagpieBinary(
  options: EnsureBinaryOptions,
): Promise<EnsureBinaryResult> {
  const { logger, force = false, signal } = options
  const assetName = releaseAssetName()
  if (assetName === undefined) {
    throw new Error(
      `当前平台（${process.platform}/${process.arch}）没有预编译的 magpie。` +
        'magpie 只发布 win32 / darwin / linux × x64 / arm64；' +
        '请手动安装后把设置里的 magpieBinary 指向它的绝对路径。',
    )
  }

  const destination = managedBinaryPath()
  if (!force && (await hasBinary())) {
    const version = await installedVersion()
    logger.debug(
      `[magpie] 二进制已就位：${destination}${version === undefined ? '' : `（${version}）`}`,
    )
    return { path: destination, version, downloaded: false }
  }

  const release = await resolveLatestRelease(logger, signal)
  if (release === undefined) {
    throw new Error(
      '拿不到 magpie 的最新版本（GitHub 不可达）。' +
        '请手动下载 https://github.com/yetone/magpie/releases 里的 ' +
        `${assetName} 放到 ${destination}，或在设置里把 magpieBinary 指向已有的二进制。`,
    )
  }

  const asset = pickAsset(release.assets, assetName)
  if (asset === undefined) {
    throw new Error(
      `发布 ${release.version} 里没有 ${assetName}。` +
        '请到 https://github.com/yetone/magpie/releases 手动确认资产名。',
    )
  }

  logger.debug(`[magpie] 下载 ${asset.name}（${release.version}）`)
  logger.debug(`[magpie]   ${asset.url}`)

  await mkdir(dirname(destination), { recursive: true })
  const partPath = `${destination}.part`
  let downloaded: { bytes: number; sha256: string }
  try {
    const response = await fetch(asset.url, {
      headers: { 'user-agent': 'dsh-magpie' },
      redirect: 'follow',
      // 同 resolveLatestRelease：超时与卸载任一触发都中断。
      signal:
        signal === undefined
          ? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
    })
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${String(response.status)} ${response.statusText}`)
    }
    downloaded = await writeStream(response, partPath, logger)
  } catch (error) {
    // 失败时清掉半截文件，否则下次 `hasBinary()` 会把它当成完整二进制。
    await rm(partPath, { force: true }).catch(() => undefined)
    throw error
  }

  if (downloaded.bytes < MIN_BINARY_BYTES) {
    await rm(partPath, { force: true }).catch(() => undefined)
    throw new Error(
      `下载到的文件只有 ${String(downloaded.bytes)} 字节，明显不完整（预期 ~69 MB）。` +
        '请检查网络或代理后重试。',
    )
  }

  try {
    // Windows 上 `rename` 到**已存在**的目标会抛 `EEXIST`（POSIX 是静默
    // 覆盖）。强制重下时先删旧的，否则用户永远卡在「下载完成但没生效」。
    await rm(destination, { force: true })
    await rename(partPath, destination)
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => undefined)
    throw new Error(
      `把下载好的文件挪到 ${destination} 失败：${
        error instanceof Error ? error.message : String(error)
      }。请检查磁盘空间与文件权限。`,
    )
  }
  if (process.platform !== 'win32') {
    await chmod(destination, 0o755)
  }

  // 记下版本号，下次 `hasBinary()` 命中时可以写进日志，也方便用户手动核对。
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    join(BIN_DIR, 'version.json'),
    `${JSON.stringify({ version: release.version, sha256: downloaded.sha256 }, null, 2)}\n`,
    'utf8',
  ).catch(() => undefined)

  logger.debug(
    `[magpie] 下载完成：${destination}（${(downloaded.bytes / 1024 / 1024).toFixed(1)} MB，` +
      `sha256 ${downloaded.sha256.slice(0, 16)}…）`,
  )
  return { path: destination, version: release.version, downloaded: true }
}
