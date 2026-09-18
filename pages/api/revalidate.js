import { getGlobalData } from '@/lib/db/getSiteData'

/**
 * 按需刷新（On-Demand Revalidation）
 *
 * 用于替代「每 N 秒自动重新生成」造成的高频 ISR 写入：
 * 平时页面保持纯静态（见 blog.config.js 的 NEXT_REVALIDATE_SECOND），
 * 只在 Notion 内容更新后调用本接口，精确刷新受影响的页面。
 *
 * 使用前请在 Vercel 环境变量中配置 REVALIDATE_SECRET（只在服务端读取，不会暴露给浏览器）。
 *
 * 用法：
 *   /api/revalidate?secret=xxx                      刷新核心页面（首页、归档、分类、标签）
 *   /api/revalidate?secret=xxx&path=/article/foo    刷新指定页面
 *   /api/revalidate?secret=xxx&paths=/a,/b          批量刷新指定页面
 *   /api/revalidate?secret=xxx&all=1                刷新全站所有文章页（页面多时较慢，可能超时）
 */

// 核心页面：内容有变动时通常都需要一起刷新
const CORE_PATHS = ['/', '/archive', '/category', '/tag']

export default async function handler(req, res) {
  const secret = process.env.REVALIDATE_SECRET

  // 未配置密钥时直接禁用，避免接口被任意调用
  if (!secret) {
    return res.status(500).json({
      status: 'error',
      message: '未配置 REVALIDATE_SECRET 环境变量，接口已禁用'
    })
  }

  const token = String(req.query?.secret || req.body?.secret || '')
  if (token !== secret) {
    return res.status(401).json({ status: 'error', message: 'secret 校验失败' })
  }

  // 计算需要刷新的路径
  const { path: single, paths: multiple, all } = req.query || {}
  let targets = CORE_PATHS
  if (single) {
    targets = [single]
  } else if (multiple) {
    targets = String(multiple).split(',')
  } else if (all) {
    targets = await getAllPaths()
  }

  const uniqueTargets = [...new Set(targets.map(normalizePath).filter(Boolean))]

  // 逐个刷新；单条失败不影响其它路径
  const success = []
  const failed = []
  for (const target of uniqueTargets) {
    try {
      await res.revalidate(target)
      success.push(target)
    } catch (error) {
      failed.push({ path: target, message: error?.message || String(error) })
    }
  }

  console.log('[revalidate]', `成功 ${success.length} 个`, `失败 ${failed.length} 个`)

  return res.status(200).json({
    status: failed.length === 0 ? 'success' : 'partial',
    message: `刷新完成：成功 ${success.length} 个，失败 ${failed.length} 个`,
    success,
    failed
  })
}

/**
 * 全站路径：核心页面 + 所有文章页
 */
async function getAllPaths() {
  const paths = [...CORE_PATHS]
  try {
    const { allPages } = await getGlobalData({ from: 'revalidate-all' })
    for (const page of allPages || []) {
      if (page?.slug) {
        paths.push('/' + page.slug)
      }
    }
  } catch (error) {
    console.error('[revalidate] 读取全站路径失败', error)
  }
  return paths
}

/**
 * 统一成以 / 开头、无重复斜杠的规范路径
 */
function normalizePath(path) {
  if (!path) {
    return ''
  }
  const target = String(path)
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  return target ? '/' + target.replace(/\/{2,}/g, '/') : '/'
}

// 全站刷新耗时较长，放宽函数超时（Vercel 上限取决于套餐）
export const config = {
  maxDuration: 60
}
