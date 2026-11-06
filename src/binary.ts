/**
 * magpie 二进制解析。
 *
 * ## 为什么需要这个
 *
 * 插件最初要求「`magpie` 已经在 PATH 里」。这不算「装完就能用」—— 用户得
 * 先去 GitHub 找 release、认平台、下载、解压、加 PATH，四步全做完才能用。
 *
 * ## 解析顺序（先命中先用）
 *
 * 1. **配置里的 `magpieBinary`** —— 显式指定，最高优先级。用户可能想用某个
 *    特定版本或自定义编译的二进制。
 * 2. **`~/.dsh/magpie/bin/magpie[.exe]`** —— 插件自己下的，跨 profile 共享。
 * 3. **系统已安装的 magpie** —— 桌面版装完就在那儿，没必要重下 69 MB。
 * 4. **`PATH` 里的 `magpie`** —— 最传统的用法。
 * 5. **都没有** —— 返回 `undefined`，由调用方决定是否下载。
 *
 * ## 为什么第 3 步要枚举安装路径
 *
 * 桌面版（`.dmg` / `.exe` 安装包）**不会**把自己加进 `PATH`，用户装完
 * 在 DSH 里跑 `magpie` 是找不到的。但二进制确实在标准位置 —— 直接去那儿
 * 拿比「重新下载 69 MB」好得多。
 *
 * @see https://github.com/yetone/magpie/releases
 */

import { access, constants, stat } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import { join } from 'node:path'

/** 插件自己的二进制目录（跨 profile、跨插件版本共享）。 */
export const MAGPIE_HOME = join(homedir(), '.dsh', 'magpie')
export const BIN_DIR = join(MAGPIE_HOME, 'bin')

/** 本地二进制文件名（Windows 带 `.exe`）。 */
export function binaryFileName(platform = osPlatform()): string {
  return platform === 'win32' ? 'magpie.exe' : 'magpie'
}

/** 插件自己下载的二进制路径。 */
export function managedBinaryPath(platform = osPlatform()): string {
  return join(BIN_DIR, binaryFileName(platform))
}

/**
 * release 资产名。
 *
 * magpie 用 Go 的 `GOOS` / `GOARCH` 命名，与 Node 的 `process.platform` /
 * `process.arch` 有两处不同：
 * - `win32` → `windows`（不是 `win`）
 * - `x64` → `amd64`（不是 `x64`）
 *
 * @returns 资产名（如 `magpie-cli-windows-amd64.exe`），不支持的平台返回 `undefined`。
 */
export function releaseAssetName(
  platform = osPlatform(),
  arch = process.arch,
): string | undefined {
  const os =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  if (os === undefined) return undefined

  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined
  if (cpu === undefined) return undefined

  return `magpie-cli-${os}-${cpu}${os === 'windows' ? '.exe' : ''}`
}

/** 文件是否可执行（存在 + 是普通文件 + 有执行位，Windows 只看存在）。 */
export async function isExecutableFile(path: string, platform = osPlatform()): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) return false
    if (platform === 'win32') return true
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 系统里可能装了 magpie 的标准位置。
 *
 * 顺序按「最可能先命中」排：
 * - **Windows**：`%LOCALAPPDATA%\Programs\magpie\`（安装包默认位置）、
 *   `%PROGRAMFILES%\magpie\`、`%PROGRAMFILES(X86)%\magpie\`
 * - **macOS**：`/Applications/magpie.app/Contents/MacOS/magpie`（`.app`
 *   包里的可执行文件）、`~/Applications/...`
 * - **Linux**：`/usr/local/bin`、`/usr/bin`、`~/.local/bin`、AppImage 常见
 *   解压位置
 *
 * @returns 绝对路径数组（不保证存在，调用方用 {@link isExecutableFile} 判）。
 */
export function systemBinaryCandidates(platform = osPlatform()): readonly string[] {
  const name = binaryFileName(platform)
  if (platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA']
    const programFiles = process.env['PROGRAMFILES']
    const programFilesX86 = process.env['PROGRAMFILES(X86)']
    return [
      ...(localAppData === undefined ? [] : [join(localAppData, 'Programs', 'magpie', name)]),
      ...(programFiles === undefined ? [] : [join(programFiles, 'magpie', name)]),
      ...(programFilesX86 === undefined ? [] : [join(programFilesX86, 'magpie', name)]),
    ]
  }
  if (platform === 'darwin') {
    return [
      join('/Applications', 'magpie.app', 'Contents', 'MacOS', 'magpie'),
      join(homedir(), 'Applications', 'magpie.app', 'Contents', 'MacOS', 'magpie'),
      '/opt/homebrew/bin/magpie',
      '/usr/local/bin/magpie',
    ]
  }
  return [
    join(homedir(), '.local', 'bin', name),
    '/usr/local/bin/magpie',
    '/usr/bin/magpie',
    '/opt/magpie/magpie',
  ]
}

/** `PATH` 里所有目录（`undefined` 条目已剔除）。 */
function pathEntries(): readonly string[] {
  const raw = process.env['PATH'] ?? process.env['Path'] ?? ''
  return raw
    .split(process.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** 在 `PATH` 里找第一个可执行的 `magpie`。 */
async function findInPath(platform = osPlatform()): Promise<string | undefined> {
  const name = binaryFileName(platform)
  for (const dir of pathEntries()) {
    const candidate = join(dir, name)
    if (await isExecutableFile(candidate, platform)) return candidate
  }
  return undefined
}

/** 解析结果。 */
export interface ResolvedBinary {
  /** 可执行文件绝对路径。 */
  readonly path: string
  /** 从哪来的（写日志用）。 */
  readonly source: 'config' | 'managed' | 'system' | 'path'
}

/**
 * 按优先级找 magpie 二进制。
 *
 * **不下载** —— 只做查找。下载由 `scripts/fetch-magpie.mjs`（`postinstall`）
 * 或 `apply()` 的后台任务负责。
 *
 * @param configured - 配置里的 `magpieBinary` 值。空串 / 默认值 `'magpie'`
 *   表示「没显式指定」—— 那时按下面的顺序找。
 * @returns 命中项，或 `undefined`（一个都没有）。
 */
export async function resolveMagpieBinary(
  configured: string | undefined,
  platform = osPlatform(),
): Promise<ResolvedBinary | undefined> {
  // 1. 显式指定：直接当路径用。相对路径也接受（`spawn` 会按 cwd 解析）。
  const explicit = configured?.trim()
  if (explicit !== undefined && explicit.length > 0 && explicit !== 'magpie') {
    if (await isExecutableFile(explicit, platform)) {
      return { path: explicit, source: 'config' }
    }
    // 显式指定但不存在 —— 继续往下找，但调用方应该 warn（配置写错了）。
  }

  // 2. 插件自己下的。
  const managed = managedBinaryPath(platform)
  if (await isExecutableFile(managed, platform)) {
    return { path: managed, source: 'managed' }
  }

  // 3. 系统安装位置。
  for (const candidate of systemBinaryCandidates(platform)) {
    if (await isExecutableFile(candidate, platform)) {
      return { path: candidate, source: 'system' }
    }
  }

  // 4. PATH。
  const inPath = await findInPath(platform)
  if (inPath !== undefined) {
    return { path: inPath, source: 'path' }
  }

  return undefined
}

/** 来源的中文说明（写日志 / 错误提示用）。 */
export function describeSource(source: ResolvedBinary['source']): string {
  switch (source) {
    case 'config':
      return '配置指定'
    case 'managed':
      return '插件自带'
    case 'system':
      return '系统安装'
    case 'path':
      return 'PATH'
    /* c8 ignore next 2 -- 穷尽联合，防御性默认分支。 */
    default:
      return String(source)
  }
}
