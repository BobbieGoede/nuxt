import { runInNewContext } from 'node:vm'
import fs from 'node:fs'
import { extname, normalize, relative, resolve } from 'pathe'
import { encodePath, joinURL, withLeadingSlash } from 'ufo'
import { logger, resolveFiles, useNuxt } from '@nuxt/kit'
import { genArrayFromRaw, genDynamicImport, genImport, genSafeVariableName } from 'knitwork'
import escapeRE from 'escape-string-regexp'
import { filename } from 'pathe/utils'
import { hash } from 'ohash'
import { transform } from 'esbuild'
import { parse } from 'acorn'
import type { CallExpression, ExpressionStatement, ObjectExpression, Program, Property } from 'estree'
import type { NuxtPage } from 'nuxt/schema'

import { uniqueBy } from '../core/utils'
import { toArray } from '../utils'

enum SegmentParserState {
  initial,
  static,
  dynamic,
  optional,
  catchall,
}

enum SegmentTokenType {
  static,
  dynamic,
  optional,
  catchall,
}

interface SegmentToken {
  type: SegmentTokenType
  value: string
}

interface ScannedFile {
  relativePath: string
  absolutePath: string
}

export async function resolvePagesRoutes (): Promise<NuxtPage[]> {
  const nuxt = useNuxt()

  const pagesDirs = nuxt.options._layers.map(
    layer => resolve(layer.config.srcDir, (layer.config.rootDir === nuxt.options.rootDir ? nuxt.options : layer.config).dir?.pages || 'pages')
  )

  const scannedFiles: ScannedFile[] = []
  for (const dir of pagesDirs) {
    const files = await resolveFiles(dir, `**/*{${nuxt.options.extensions.join(',')}}`)
    scannedFiles.push(...files.map(file => ({ relativePath: relative(dir, file), absolutePath: file })))
  }

  // sort scanned files using en-US locale to make the result consistent across different system locales
  scannedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en-US'))

  const allRoutes = await generateRoutesFromFiles(uniqueBy(scannedFiles, 'relativePath'), {
    shouldExtractBuildMeta: nuxt.options.experimental.scanPageMeta || nuxt.options.experimental.typedPages,
    vfs: nuxt.vfs
  })

  return uniqueBy(allRoutes, 'path')
}

type GenerateRoutesFromFilesOptions = {
  shouldExtractBuildMeta?: boolean
  vfs?: Record<string, string>
}

export async function generateRoutesFromFiles (files: ScannedFile[], options: GenerateRoutesFromFilesOptions = {}): Promise<NuxtPage[]> {
  const routes: NuxtPage[] = []

  for (const file of files) {
    const segments = file.relativePath
      .replace(new RegExp(`${escapeRE(extname(file.relativePath))}$`), '')
      .split('/')

    const route: NuxtPage = {
      name: '',
      path: '',
      file: file.absolutePath,
      children: []
    }

    // Array where routes should be added, useful when adding child routes
    let parent = routes

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]

      const tokens = parseSegment(segment)
      const segmentName = tokens.map(({ value }) => value).join('')

      // ex: parent/[slug].vue -> parent-slug
      route.name += (route.name && '/') + segmentName

      // ex: parent.vue + parent/child.vue
      const path = withLeadingSlash(joinURL(route.path, getRoutePath(tokens).replace(/\/index$/, '/')))
      const child = parent.find(parentRoute => parentRoute.name === route.name && parentRoute.path === path)

      if (child && child.children) {
        parent = child.children
        route.path = ''
      } else if (segmentName === 'index' && !route.path) {
        route.path += '/'
      } else if (segmentName !== 'index') {
        route.path += getRoutePath(tokens)
      }
    }

    if (options.shouldExtractBuildMeta && options.vfs) {
      const fileContent = file.absolutePath in options.vfs ? options.vfs[file.absolutePath] : fs.readFileSync(file.absolutePath, 'utf-8')
      Object.assign(route, await getRouteMeta(fileContent, file.absolutePath))
    }

    parent.push(route)
  }

  return prepareRoutes(routes)
}

const SFC_SCRIPT_RE = /<script\s*[^>]*>([\s\S]*?)<\/script\s*[^>]*>/i
export function extractScriptContent (html: string) {
  const match = html.match(SFC_SCRIPT_RE)

  if (match && match[1]) {
    return match[1].trim()
  }

  return null
}

const PAGE_META_RE = /(definePageMeta\([\s\S]*?\))/

const metaCache: Record<string, Partial<Record<keyof NuxtPage, any>>> = {}
async function getRouteMeta (contents: string, absolutePath?: string): Promise<Partial<Record<keyof NuxtPage, any>>> {
  if (contents in metaCache) { return metaCache[contents] }

  const script = extractScriptContent(contents)
  if (!script) {
    metaCache[contents] = {}
    return {}
  }

  if (!PAGE_META_RE.test(script)) {
    metaCache[contents] = {}
    return {}
  }

  const js = await transform(script, { loader: 'ts' })
  const ast = parse(js.code, {
    sourceType: 'module',
    ecmaVersion: 'latest',
    ranges: true
  }) as unknown as Program
  const pageMetaAST = ast.body.find(node => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' && node.expression.callee.type === 'Identifier' && node.expression.callee.name === 'definePageMeta')
  if (!pageMetaAST) {
    metaCache[contents] = {}
    return {}
  }

  const pageMetaArgument = ((pageMetaAST as ExpressionStatement).expression as CallExpression).arguments[0] as ObjectExpression
  const extractedMeta = {} as Partial<Record<keyof NuxtPage, any>>
  for (const key of ['name', 'path', 'alias', 'redirect'] as const) {
    const property = pageMetaArgument.properties.find(property => property.type === 'Property' && property.key.type === 'Identifier' && property.key.name === key) as Property
    if (!property) { continue }

    if (property.value.type === 'ObjectExpression') {
      const valueString = js.code.slice(property.value.range![0], property.value.range![1])
      try {
        extractedMeta[key] = JSON.parse(runInNewContext(`JSON.stringify(${valueString})`, {}))
      } catch {
        console.debug(`[nuxt] Skipping extraction of \`${key}\` metadata as it is not JSON-serializable (reading \`${absolutePath}\`).`)
        continue
      }
    }

    if (property.value.type === 'ArrayExpression') {
      const values = []
      for (const element of property.value.elements) {
        if (!element) {
          continue
        }
        if (element.type !== 'Literal' || typeof element.value !== 'string') {
          console.debug(`[nuxt] Skipping extraction of \`${key}\` metadata as it is not an array of string literals (reading \`${absolutePath}\`).`)
          continue
        }
        values.push(element.value)
      }
      extractedMeta[key] = values
      continue
    }

    if (property.value.type !== 'Literal' || typeof property.value.value !== 'string') {
      console.debug(`[nuxt] Skipping extraction of \`${key}\` metadata as it is not a string literal or array of string literals (reading \`${absolutePath}\`).`)
      continue
    }
    extractedMeta[key] = property.value.value
  }

  metaCache[contents] = extractedMeta
  return extractedMeta
}

function getRoutePath (tokens: SegmentToken[]): string {
  return tokens.reduce((path, token) => {
    return (
      path +
      (token.type === SegmentTokenType.optional
        ? `:${token.value}?`
        : token.type === SegmentTokenType.dynamic
          ? `:${token.value}()`
          : token.type === SegmentTokenType.catchall
            ? `:${token.value}(.*)*`
            : encodePath(token.value).replace(/:/g, '\\:'))
    )
  }, '/')
}

const PARAM_CHAR_RE = /[\w\d_.]/

function parseSegment (segment: string) {
  let state: SegmentParserState = SegmentParserState.initial
  let i = 0

  let buffer = ''
  const tokens: SegmentToken[] = []

  function consumeBuffer () {
    if (!buffer) {
      return
    }
    if (state === SegmentParserState.initial) {
      throw new Error('wrong state')
    }

    tokens.push({
      type:
        state === SegmentParserState.static
          ? SegmentTokenType.static
          : state === SegmentParserState.dynamic
            ? SegmentTokenType.dynamic
            : state === SegmentParserState.optional
              ? SegmentTokenType.optional
              : SegmentTokenType.catchall,
      value: buffer
    })

    buffer = ''
  }

  while (i < segment.length) {
    const c = segment[i]

    switch (state) {
      case SegmentParserState.initial:
        buffer = ''
        if (c === '[') {
          state = SegmentParserState.dynamic
        } else {
          i--
          state = SegmentParserState.static
        }
        break

      case SegmentParserState.static:
        if (c === '[') {
          consumeBuffer()
          state = SegmentParserState.dynamic
        } else {
          buffer += c
        }
        break

      case SegmentParserState.catchall:
      case SegmentParserState.dynamic:
      case SegmentParserState.optional:
        if (buffer === '...') {
          buffer = ''
          state = SegmentParserState.catchall
        }
        if (c === '[' && state === SegmentParserState.dynamic) {
          state = SegmentParserState.optional
        }
        if (c === ']' && (state !== SegmentParserState.optional || segment[i - 1] === ']')) {
          if (!buffer) {
            throw new Error('Empty param')
          } else {
            consumeBuffer()
          }
          state = SegmentParserState.initial
        } else if (PARAM_CHAR_RE.test(c)) {
          buffer += c
        } else {

          // console.debug(`[pages]Ignored character "${c}" while building param "${buffer}" from "segment"`)
        }
        break
    }
    i++
  }

  if (state === SegmentParserState.dynamic) {
    throw new Error(`Unfinished param "${buffer}"`)
  }

  consumeBuffer()

  return tokens
}

function findRouteByName (name: string, routes: NuxtPage[]): NuxtPage | undefined {
  for (const route of routes) {
    if (route.name === name) {
      return route
    }
  }
  return findRouteByName(name, routes)
}

function prepareRoutes (routes: NuxtPage[], parent?: NuxtPage, names = new Set<string>()) {
  for (const route of routes) {
    // Remove -index
    if (route.name) {
      route.name = route.name
        .replace(/\/index$/, '')
        .replace(/\//g, '-')

      if (names.has(route.name)) {
        const existingRoute = findRouteByName(route.name, routes)
        const extra = existingRoute?.name ? `is the same as \`${existingRoute.file}\`` : 'is a duplicate'
        logger.warn(`Route name generated for \`${route.file}\` ${extra}. You may wish to set a custom name using \`definePageMeta\` within the page file.`)
      }
    }

    // Remove leading / if children route
    if (parent && route.path[0] === '/') {
      route.path = route.path.slice(1)
    }

    if (route.children?.length) {
      route.children = prepareRoutes(route.children, route, names)
    }

    if (route.children?.find(childRoute => childRoute.path === '')) {
      delete route.name
    }

    if (route.name) {
      names.add(route.name)
    }
  }

  return routes
}

export function normalizeRoutes (routes: NuxtPage[], metaImports: Set<string> = new Set(), overrideMeta = false): { imports: Set<string>, routes: string } {
  return {
    imports: metaImports,
    routes: genArrayFromRaw(routes.map((page) => {
      const metaFiltered = Object.values(page.meta || {}).filter(value => value !== undefined)
      const aliasFiltered = toArray(page.alias).filter(Boolean)
      
      const route: Record<Exclude<keyof NuxtPage, 'file'>, string> & { component?: string } = Object.create({
        path: page.path !== undefined ? JSON.stringify(page.path) : undefined,
        name: page.name !== undefined ? JSON.stringify(page.name) : undefined,
        meta: metaFiltered.length ? JSON.stringify(metaFiltered) : undefined,
        alias: aliasFiltered.length ? JSON.stringify(aliasFiltered) : undefined,
        redirect: page.redirect ? JSON.stringify(page.redirect) : undefined,
      })

      if (page.children?.length) {
        route.children = normalizeRoutes(page.children, metaImports, overrideMeta).routes
      }

      // Without a file, we can't use `definePageMeta` to extract route-level meta from the file
      if (!page.file) {
        return route
      }

      const file = normalize(page.file)
      const metaImportName = genSafeVariableName(filename(file) + hash(file)) + 'Meta'
      metaImports.add(genImport(`${file}?macro=true`, [{ name: 'default', as: metaImportName }]))

      const metaRoute = {
        name: `${metaImportName}?.name ?? ${route.name}`,
        path: `${metaImportName}?.path ?? ${route.path}`,
        meta: `${metaImportName} || {}`,
        alias: `${metaImportName}?.alias || []`,
        redirect: `${metaImportName}?.redirect`,
        component: genDynamicImport(file, { interopDefault: true })
      }

      if (overrideMeta) {
        metaRoute.name = route.name ?? `${metaImportName}?.name`
        metaRoute.path = route.path ?? `${metaImportName}?.path ?? ''`
      }

      if(route.children != null) {
        metaRoute.children = route.children
      }

      if (route.meta != null) {
        metaRoute.meta = `{ ...(${metaImportName}) || {}), ...${route.meta} }`
      }

      if (route.alias != null) {
        metaRoute.alias = `${route.alias}.concat(${metaImportName}?.alias || [])`
      }

      if (route.redirect != null) {
        metaRoute.redirect = route.redirect
      }

      return metaRoute
    }))
  }
}

export function pathToNitroGlob (path: string) {
  if (!path) {
    return null
  }
  // Ignore pages with multiple dynamic parameters.
  if (path.indexOf(':') !== path.lastIndexOf(':')) {
    return null
  }

  return path.replace(/\/(?:[^:/]+)?:\w+.*$/, '/**')
}
