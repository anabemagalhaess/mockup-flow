'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readPsd, getLayerCanvas, getLayerMaskCanvas, getCompositeCanvas, type Layer, type Psd } from 'ag-psd'
import JSZip from 'jszip'
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  FileImage,
  FolderOpen,
  ImagePlus,
  Layers2,
  LoaderCircle,
  Plus,
  ScanLine,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'

type PsdLayer = Layer
type Mockup = {
  id: string
  file: File
  data: ArrayBuffer
  psd: Psd
  layers: PsdLayer[]
  composite: HTMLCanvasElement
  targetId: string
  previewUrl: string
  width: number
  height: number
}
type Artwork = { id: string; file: File; previewUrl: string }
type ExportFormat = 'png' | 'jpg'
type StoredMockup = { name: string; data: ArrayBuffer; targetId: string }
type StoredProject = { id: string; name: string; updatedAt: number; mockups: StoredMockup[] }
type BackupManifest = {
  format: 'atelier-mockup-library'
  version: 1
  createdAt: number
  collections: Array<{
    name: string
    mockups: Array<{ name: string; targetId: string; path: string }>
  }>
}
type ViewMode = 'single' | 'grid'

const layerKeywords = /clip|mask|design|artwork|art\b|print|placeholder|insert/i
const layerIds = new WeakMap<Layer, string>()
const databaseName = 'atelier-mockup-studio'
const projectStore = 'projects'

function openStudioDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(projectStore, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Não foi possível abrir a biblioteca local.'))
  })
}

async function readStoredProjects() {
  const database = await openStudioDatabase()
  return new Promise<StoredProject[]>((resolve, reject) => {
    const request = database.transaction(projectStore, 'readonly').objectStore(projectStore).getAll()
    request.onsuccess = () => resolve((request.result as StoredProject[]).sort((a, b) => b.updatedAt - a.updatedAt))
    request.onerror = () => reject(request.error || new Error('Não foi possível ler os projetos guardados.'))
  })
}

async function saveStoredProject(project: StoredProject) {
  const database = await openStudioDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(projectStore, 'readwrite')
    transaction.objectStore(projectStore).put(project)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Não foi possível guardar este projeto.'))
  })
}

async function deleteStoredProject(id: string) {
  const database = await openStudioDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(projectStore, 'readwrite')
    transaction.objectStore(projectStore).delete(id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Não foi possível eliminar este projeto.'))
  })
}

function layerId(layer: Layer) {
  return layerIds.get(layer) || ''
}

function flattenLayers(layers: Layer[] = [], result: PsdLayer[] = []) {
  for (const layer of layers) {
    layerIds.set(layer, `${layer.name || 'layer'}-${result.length}-${layer.left || 0}-${layer.top || 0}`)
    if (layer.children?.length) flattenLayers(layer.children, result)
    else result.push(layer)
  }
  return result
}

function layerHasMask(layer: Layer) {
  return Boolean(layer.mask?.canvas || layer.mask?.imageData || layer.vectorMask?.paths.length)
}

function findTarget(layers: PsdLayer[]) {
  const namedMask = layers.find((layer) => layerKeywords.test(layer.name || '') && (layerHasMask(layer) || layer.canvas || layer.imageData))
  const clippedLayer = layers.find((layer) => layer.clipping && (layerHasMask(layer) || layer.canvas || layer.imageData))
  const maskedLayer = layers.find(layerHasMask)
  const namedLayer = layers.find((layer) => layerKeywords.test(layer.name || ''))
  const imageLayer = layers.find((layer) => layer.canvas || layer.imageData)
  return layerId(namedMask || clippedLayer || maskedLayer || namedLayer || imageLayer || layers[0])
}

function toCanvas(layer: Layer) {
  return getLayerCanvas(layer)
}

function layerMaskCanvas(layer: Layer) {
  return getLayerMaskCanvas(layer)
}

function getMaskDocumentPosition(layer: Layer) {
  const mask = layer.mask
  if (!mask) return { x: layer.left || 0, y: layer.top || 0 }
  return mask.positionRelativeToLayer
    ? { x: (layer.left || 0) + (mask.left || 0), y: (layer.top || 0) + (mask.top || 0) }
    : { x: mask.left ?? layer.left ?? 0, y: mask.top ?? layer.top ?? 0 }
}

function makeVectorAlphaMask(layer: Layer, width: number, height: number) {
  const vectorMask = layer.vectorMask
  if (!vectorMask || vectorMask.disable) return undefined
  const alpha = document.createElement('canvas')
  alpha.width = width
  alpha.height = height
  const context = alpha.getContext('2d')
  if (!context) return undefined
  if (vectorMask.fillStartsWithAllPixels) {
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
  }

  for (const path of vectorMask.paths) {
    if (path.open || path.knots.length < 2) continue
    const shape = document.createElement('canvas')
    shape.width = width
    shape.height = height
    const shapeContext = shape.getContext('2d')
    if (!shapeContext) continue
    const first = path.knots[0]
    shapeContext.beginPath()
    shapeContext.moveTo(first.points[0], first.points[1])
    for (let index = 1; index <= path.knots.length; index += 1) {
      const previous = path.knots[index - 1]
      const next = path.knots[index % path.knots.length]
      shapeContext.bezierCurveTo(previous.points[4], previous.points[5], next.points[2], next.points[3], next.points[0], next.points[1])
    }
    shapeContext.closePath()
    shapeContext.fillStyle = '#fff'
    shapeContext.fill(path.fillRule === 'even-odd' ? 'evenodd' : 'nonzero')

    const operation = path.operation || 'combine'
    context.save()
    context.globalCompositeOperation = operation === 'subtract'
      ? 'destination-out'
      : operation === 'intersect'
        ? 'destination-in'
        : operation === 'exclude'
          ? 'xor'
          : 'source-over'
    context.drawImage(shape, 0, 0)
    context.restore()
  }

  if (vectorMask.invert) {
    const inverse = document.createElement('canvas')
    inverse.width = width
    inverse.height = height
    const inverseContext = inverse.getContext('2d')
    if (!inverseContext) return undefined
    inverseContext.fillStyle = '#fff'
    inverseContext.fillRect(0, 0, width, height)
    inverseContext.globalCompositeOperation = 'destination-out'
    inverseContext.drawImage(alpha, 0, 0)
    return inverse
  }
  return alpha
}

function makeAlphaMask(layer: Layer, width: number, height: number) {
  const mask = layerMaskCanvas(layer)
  let alpha: HTMLCanvasElement | undefined
  if (mask && !layer.mask?.disabled) {
    const source = document.createElement('canvas')
    source.width = mask.width
    source.height = mask.height
    const sourceContext = source.getContext('2d', { willReadFrequently: true })
    if (sourceContext) {
      sourceContext.drawImage(mask, 0, 0)
      const pixels = sourceContext.getImageData(0, 0, source.width, source.height)
      for (let index = 0; index < pixels.data.length; index += 4) {
        const luminance = (pixels.data[index] * 0.2126 + pixels.data[index + 1] * 0.7152 + pixels.data[index + 2] * 0.0722) / 255
        pixels.data[index] = 255
        pixels.data[index + 1] = 255
        pixels.data[index + 2] = 255
        pixels.data[index + 3] = Math.round(pixels.data[index + 3] * luminance)
      }
      sourceContext.putImageData(pixels, 0, 0)
      alpha = document.createElement('canvas')
      alpha.width = width
      alpha.height = height
      const alphaContext = alpha.getContext('2d')
      if (!alphaContext) return undefined
      const position = getMaskDocumentPosition(layer)
      alphaContext.drawImage(source, position.x, position.y)
    }
  }

  const vectorAlpha = makeVectorAlphaMask(layer, width, height)
  if (!alpha) return vectorAlpha
  if (vectorAlpha) {
    const context = alpha.getContext('2d')
    if (context) {
      context.globalCompositeOperation = 'destination-in'
      context.drawImage(vectorAlpha, 0, 0)
    }
  }
  return alpha
}

function makeLayerAlphaMask(layer: Layer, width: number, height: number) {
  const canvas = toCanvas(layer)
  if (!canvas) return undefined
  const alpha = document.createElement('canvas')
  alpha.width = width
  alpha.height = height
  const context = alpha.getContext('2d')
  if (!context) return undefined
  context.drawImage(canvas, layer.left || 0, layer.top || 0)
  const vectorAlpha = makeVectorAlphaMask(layer, width, height)
  if (vectorAlpha) {
    context.globalCompositeOperation = 'destination-in'
    context.drawImage(vectorAlpha, 0, 0)
  }
  return alpha
}

function makeMaskBoundsAlphaMask(layer: Layer, width: number, height: number) {
  const mask = layer.mask
  if (!mask || mask.disabled) return undefined
  const maskWidth = (mask.right ?? 0) - (mask.left ?? 0)
  const maskHeight = (mask.bottom ?? 0) - (mask.top ?? 0)
  if (maskWidth <= 0 || maskHeight <= 0) return undefined
  const alpha = document.createElement('canvas')
  alpha.width = width
  alpha.height = height
  const context = alpha.getContext('2d')
  if (!context) return undefined
  const position = getMaskDocumentPosition(layer)
  context.fillStyle = '#fff'
  context.fillRect(position.x, position.y, maskWidth, maskHeight)
  return alpha
}

function makeLayerBoundsAlphaMask(layer: Layer, width: number, height: number) {
  const layerWidth = (layer.right ?? 0) - (layer.left ?? 0)
  const layerHeight = (layer.bottom ?? 0) - (layer.top ?? 0)
  if (layerWidth <= 0 || layerHeight <= 0) return undefined
  const alpha = document.createElement('canvas')
  alpha.width = width
  alpha.height = height
  const context = alpha.getContext('2d')
  if (!context) return undefined
  context.fillStyle = '#fff'
  context.fillRect(layer.left ?? 0, layer.top ?? 0, layerWidth, layerHeight)
  return alpha
}

function findClippingBase(layers: Layer[], layerIndex: number) {
  if (!layers[layerIndex]?.clipping) return undefined
  return layers.slice(layerIndex + 1).find((layer) => !layer.clipping && (toCanvas(layer) || layerHasMask(layer) || ((layer.right ?? 0) > (layer.left ?? 0) && (layer.bottom ?? 0) > (layer.top ?? 0))))
}

type MaskPoint = { x: number; y: number }

function simplifyMaskEdge(points: MaskPoint[], tolerance: number) {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const pending: [number, number][] = [[0, points.length - 1]]
  const toleranceSquared = tolerance * tolerance

  while (pending.length) {
    const [start, end] = pending.pop()!
    const first = points[start]
    const last = points[end]
    const dx = last.x - first.x
    const dy = last.y - first.y
    let farthest = -1
    let maximumDistance = toleranceSquared

    for (let index = start + 1; index < end; index += 1) {
      const point = points[index]
      const distance = dx === 0 && dy === 0
        ? (point.x - first.x) ** 2 + (point.y - first.y) ** 2
        : ((point.x - first.x) * dy - (point.y - first.y) * dx) ** 2 / (dx * dx + dy * dy)
      if (distance > maximumDistance) {
        maximumDistance = distance
        farthest = index
      }
    }

    if (farthest >= 0) {
      keep[farthest] = 1
      pending.push([start, farthest], [farthest, end])
    }
  }

  return points.filter((_, index) => keep[index])
}

function maskConvexHull(points: MaskPoint[]) {
  const sorted = points.sort((first, second) => first.x - second.x || first.y - second.y)
  const cross = (origin: MaskPoint, first: MaskPoint, second: MaskPoint) =>
    (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x)
  const lower: MaskPoint[] = []
  const upper: MaskPoint[] = []

  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop()
    lower.push(point)
  }
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop()
    upper.push(point)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

function findPerspectiveCorners(data: Uint8ClampedArray, width: number, height: number): MaskPoint[] | undefined {
  const outline: MaskPoint[] = []
  const isInside = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && data[(y * width + x) * 4 + 3] >= 128

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if (!isInside(x, y)) continue
      if (!isInside(x - 1, y) || !isInside(x + 1, y) || !isInside(x, y - 1) || !isInside(x, y + 1)) outline.push({ x: x + 0.5, y: y + 0.5 })
    }
  }
  if (outline.length < 4) return undefined

  const hull = maskConvexHull(outline)
  if (hull.length < 4) return undefined
  const first = hull[0]
  let secondIndex = 1
  for (let index = 2; index < hull.length; index += 1) {
    const candidate = hull[index]
    const current = hull[secondIndex]
    if ((candidate.x - first.x) ** 2 + (candidate.y - first.y) ** 2 > (current.x - first.x) ** 2 + (current.y - first.y) ** 2) secondIndex = index
  }
  const second = hull[secondIndex]
  let oppositeIndex = secondIndex
  for (let index = 0; index < hull.length; index += 1) {
    const candidate = hull[index]
    const current = hull[oppositeIndex]
    if ((candidate.x - second.x) ** 2 + (candidate.y - second.y) ** 2 > (current.x - second.x) ** 2 + (current.y - second.y) ** 2) oppositeIndex = index
  }

  const followHull = (start: number, end: number, step: 1 | -1) => {
    const edge: MaskPoint[] = []
    for (let index = start; ; index = (index + step + hull.length) % hull.length) {
      edge.push(hull[index])
      if (index === end) break
    }
    return edge
  }
  const diagonal = Math.hypot(second.x - hull[oppositeIndex].x, second.y - hull[oppositeIndex].y)
  let tolerance = Math.max(1, diagonal * 0.002)
  while (tolerance <= diagonal * 0.035) {
    const firstEdge = simplifyMaskEdge(followHull(secondIndex, oppositeIndex, 1), tolerance)
    const secondEdge = simplifyMaskEdge(followHull(oppositeIndex, secondIndex, 1), tolerance)
    const corners = [...firstEdge.slice(0, -1), ...secondEdge.slice(0, -1)]
    if (corners.length === 4) {
      const center = corners.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 })
      const ordered = corners.sort((first, second) =>
        Math.atan2(first.y - center.y, first.x - center.x) - Math.atan2(second.y - center.y, second.x - center.x))
      const topLeft = ordered.reduce((best, point) => point.x + point.y < best.x + best.y ? point : best, ordered[0])
      const topLeftIndex = ordered.indexOf(topLeft)
      return [...ordered.slice(topLeftIndex), ...ordered.slice(0, topLeftIndex)]
    }
    tolerance *= 1.35
  }
  return undefined
}

function analyzeMask(mask: HTMLCanvasElement) {
  const context = mask.getContext('2d', { willReadFrequently: true })
  if (!context) return undefined
  const { data, width, height } = context.getImageData(0, 0, mask.width, mask.height)
  let minX = width, minY = height, maxX = -1, maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < 24) continue
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) return undefined
  return {
    bounds: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    corners: findPerspectiveCorners(data, width, height),
  }
}

function createMockupPreview(composite: HTMLCanvasElement, width: number, height: number) {
  const scale = Math.min(1, 1400 / width, 1400 / height)
  const preview = document.createElement('canvas')
  preview.width = Math.max(1, Math.round(width * scale))
  preview.height = Math.max(1, Math.round(height * scale))
  const context = preview.getContext('2d')
  if (!context) throw new Error('Não foi possível preparar a pré-visualização do mockup.')
  context.drawImage(composite, 0, 0, preview.width, preview.height)
  return preview.toDataURL('image/webp', 0.84)
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Não foi possível criar o ficheiro de exportação.')), type, quality)
  })
}

function fitImage(context: CanvasRenderingContext2D, image: CanvasImageSource, imageWidth: number, imageHeight: number, x: number, y: number, width: number, height: number) {
  const scale = Math.max(width / imageWidth, height / imageHeight)
  const drawWidth = imageWidth * scale
  const drawHeight = imageHeight * scale
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight)
}

function solveLinearSystem(matrix: number[][], values: number[]) {
  const rows = matrix.map((row, index) => [...row, values[index]])
  const size = values.length
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row
    }
    if (Math.abs(rows[pivot][column]) < 1e-10) return undefined
    ;[rows[column], rows[pivot]] = [rows[pivot], rows[column]]
    const divisor = rows[column][column]
    for (let index = column; index <= size; index += 1) rows[column][index] /= divisor
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const factor = rows[row][column]
      for (let index = column; index <= size; index += 1) rows[row][index] -= factor * rows[column][index]
    }
  }
  return rows.map((row) => row[size])
}

function getPerspectiveTransform(source: MaskPoint[], destination: MaskPoint[]) {
  const matrix: number[][] = []
  const values: number[] = []
  source.forEach(({ x, y }, index) => {
    const { x: u, y: v } = destination[index]
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    values.push(u)
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    values.push(v)
  })
  const solved = solveLinearSystem(matrix, values)
  return solved ? [...solved, 1] : undefined
}

function projectPoint(transform: number[], point: MaskPoint): MaskPoint {
  const divisor = transform[6] * point.x + transform[7] * point.y + 1
  return {
    x: (transform[0] * point.x + transform[1] * point.y + transform[2]) / divisor,
    y: (transform[3] * point.x + transform[4] * point.y + transform[5]) / divisor,
  }
}

function drawPerspective(context: CanvasRenderingContext2D, source: HTMLCanvasElement, corners: MaskPoint[]) {
  const sourceCorners = [
    { x: 0, y: 0 },
    { x: source.width, y: 0 },
    { x: source.width, y: source.height },
    { x: 0, y: source.height },
  ]
  const transform = getPerspectiveTransform(sourceCorners, corners)
  if (!transform) return false

  const divisions = 24
  const drawTriangle = (points: MaskPoint[]) => {
    const projected = points.map((point) => projectPoint(transform, point))
    const [first, second, third] = points
    const [projectedFirst, projectedSecond, projectedThird] = projected
    const affineX = solveLinearSystem(
      [[first.x, first.y, 1], [second.x, second.y, 1], [third.x, third.y, 1]],
      [projectedFirst.x, projectedSecond.x, projectedThird.x],
    )
    const affineY = solveLinearSystem(
      [[first.x, first.y, 1], [second.x, second.y, 1], [third.x, third.y, 1]],
      [projectedFirst.y, projectedSecond.y, projectedThird.y],
    )
    if (!affineX || !affineY) return

    const center = projected.reduce((sum, point) => ({ x: sum.x + point.x / 3, y: sum.y + point.y / 3 }), { x: 0, y: 0 })
    const clipPoints = projected.map((point) => {
      const distance = Math.hypot(point.x - center.x, point.y - center.y) || 1
      return { x: point.x + (point.x - center.x) * 0.35 / distance, y: point.y + (point.y - center.y) * 0.35 / distance }
    })
    const sourceLeft = Math.max(0, Math.min(...points.map((point) => point.x)) - 1)
    const sourceTop = Math.max(0, Math.min(...points.map((point) => point.y)) - 1)
    const sourceRight = Math.min(source.width, Math.max(...points.map((point) => point.x)) + 1)
    const sourceBottom = Math.min(source.height, Math.max(...points.map((point) => point.y)) + 1)
    if (sourceRight <= sourceLeft || sourceBottom <= sourceTop) return

    context.save()
    context.beginPath()
    context.moveTo(clipPoints[0].x, clipPoints[0].y)
    context.lineTo(clipPoints[1].x, clipPoints[1].y)
    context.lineTo(clipPoints[2].x, clipPoints[2].y)
    context.closePath()
    context.clip()
    context.setTransform(affineX[0], affineY[0], affineX[1], affineY[1], affineX[2], affineY[2])
    context.drawImage(source, sourceLeft, sourceTop, sourceRight - sourceLeft, sourceBottom - sourceTop, sourceLeft, sourceTop, sourceRight - sourceLeft, sourceBottom - sourceTop)
    context.restore()
  }

  for (let row = 0; row < divisions; row += 1) {
    for (let column = 0; column < divisions; column += 1) {
      const left = source.width * column / divisions
      const right = source.width * (column + 1) / divisions
      const top = source.height * row / divisions
      const bottom = source.height * (row + 1) / divisions
      drawTriangle([{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }])
      drawTriangle([{ x: left, y: top }, { x: right, y: bottom }, { x: left, y: bottom }])
    }
  }
  return true
}

async function parseMockup(file: File, data: ArrayBuffer, savedTargetId?: string): Promise<Mockup> {
  const psd = readPsd(data, { skipCompositeImageData: false, skipLayerImageData: false, skipLinkedFilesData: true })
  const layers = flattenLayers(psd.children || [])
  if (!layers.length) throw new Error('Este PSD não contém camadas com imagem.')
  const width = psd.width, height = psd.height
  const mergedComposite = psd.canvas || getCompositeCanvas(psd)
  const composite = mergedComposite || document.createElement('canvas')
  if (!composite.width || !composite.height) { composite.width = width; composite.height = height }
  if (!mergedComposite) {
    const context = composite.getContext('2d')
    if (!context) throw new Error('Não foi possível criar a pré-visualização.')
    for (const layer of [...layers].reverse()) {
      const canvas = toCanvas(layer)
      if (canvas && !layer.hidden) context.drawImage(canvas, layer.left || 0, layer.top || 0)
    }
  }
  const fileId = `${file.name}-${file.size}-${file.lastModified}`
  const targetId = savedTargetId && layers.some((layer) => layerId(layer) === savedTargetId) ? savedTargetId : findTarget(layers)
  return { id: fileId, file, data, psd, layers, composite, targetId, previewUrl: createMockupPreview(composite, width, height), width, height }
}

async function renderMockup(mockup: Mockup, artwork: Artwork, targetId: string, format: ExportFormat) {
  const targetIndex = mockup.layers.findIndex((layer) => layerId(layer) === targetId)
  const target = mockup.layers[targetIndex]
  if (!target) throw new Error('Escolhe uma camada de destino válida.')

  const clippingBase = findClippingBase(mockup.layers, targetIndex)
  let alphaMask = makeAlphaMask(target, mockup.width, mockup.height) || makeLayerAlphaMask(target, mockup.width, mockup.height)
  let replacedLayer: Layer | undefined
  if (!alphaMask && clippingBase) {
    alphaMask = makeAlphaMask(clippingBase, mockup.width, mockup.height) || makeLayerAlphaMask(clippingBase, mockup.width, mockup.height)
    if (alphaMask) replacedLayer = clippingBase
  }
  if (!alphaMask) alphaMask = makeMaskBoundsAlphaMask(target, mockup.width, mockup.height)
  if (!alphaMask && clippingBase) {
    alphaMask = makeMaskBoundsAlphaMask(clippingBase, mockup.width, mockup.height) || makeLayerBoundsAlphaMask(clippingBase, mockup.width, mockup.height)
    if (alphaMask) replacedLayer = clippingBase
  }
  if (!alphaMask) alphaMask = makeLayerBoundsAlphaMask(target, mockup.width, mockup.height)
  if (!alphaMask) throw new Error(`A camada “${target.name || 'selecionada'}” não tem uma forma nem limites de recorte no PSD.`)

  const geometry = analyzeMask(alphaMask)
  if (!geometry) throw new Error('Não foi possível ler a máscara da camada de destino.')
  if (!geometry.bounds) throw new Error(`A máscara da camada “${target.name || 'selecionada'}” está vazia.`)
  const bounds = geometry.bounds

  const output = document.createElement('canvas')
  output.width = mockup.width
  output.height = mockup.height
  const context = output.getContext('2d')
  if (!context) throw new Error('Este browser não suporta composição em canvas.')
  if (format === 'jpg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, output.width, output.height) }

  const drawLayer = (layer: Layer) => {
    if (layer.hidden || layer === replacedLayer) return
    const canvas = toCanvas(layer)
    if (canvas) context.drawImage(canvas, layer.left || 0, layer.top || 0)
  }
  if (mockup.composite) context.drawImage(mockup.composite, 0, 0)
  else {
    for (let index = mockup.layers.length - 1; index > targetIndex; index -= 1) drawLayer(mockup.layers[index])
  }

  const bitmap = await createImageBitmap(artwork.file)
  const art = document.createElement('canvas')
  art.width = Math.max(1, Math.round(bounds.width))
  art.height = Math.max(1, Math.round(bounds.height))
  const artContext = art.getContext('2d')
  if (!artContext) { bitmap.close(); throw new Error('Não foi possível preparar a ilustração.') }
  fitImage(artContext, bitmap, bitmap.width, bitmap.height, 0, 0, art.width, art.height)
  bitmap.close()

  const clippedArt = document.createElement('canvas')
  clippedArt.width = output.width
  clippedArt.height = output.height
  const clippedContext = clippedArt.getContext('2d')
  if (!clippedContext) throw new Error('Não foi possível preparar a área de recorte.')
  const perspectiveCorners = geometry.corners
  const perspectiveApplied = perspectiveCorners ? drawPerspective(clippedContext, art, perspectiveCorners) : false
  if (!perspectiveApplied) clippedContext.drawImage(art, bounds.left, bounds.top)
  clippedContext.globalCompositeOperation = 'destination-in'
  clippedContext.drawImage(alphaMask, 0, 0)
  context.drawImage(clippedArt, 0, 0)

  for (let index = targetIndex - 1; index >= 0; index -= 1) drawLayer(mockup.layers[index])
  const blob = await canvasToBlob(output, format === 'png' ? 'image/png' : 'image/jpeg', format === 'jpg' ? 0.96 : undefined)
  return { blob, width: output.width, height: output.height }
}

function Dropzone({
  title,
  subtitle,
  accept,
  multiple,
  onFiles,
  compact = false,
}: {
  title: string
  subtitle: string
  accept: string
  multiple?: boolean
  onFiles: (files: FileList | null) => void
  compact?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  return (
    <div
      className={`dropzone${compact ? ' dropzone-compact' : ''}${dragging ? ' is-dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); onFiles(event.dataTransfer.files) }}
    >
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} onChange={(event) => { onFiles(event.target.files); event.target.value = '' }} />
      <button className="dropzone-button" onClick={() => inputRef.current?.click()} type="button" aria-label={title}>
        <span className="dropzone-icon"><Upload size={18} strokeWidth={1.8} /></span>
        {!compact && <span className="dropzone-copy"><strong>{title}</strong><span>{subtitle}</span></span>}
        {compact && <span className="dropzone-compact-copy">{title}</span>}
        {compact && <Plus className="dropzone-plus" size={16} />}
      </button>
    </div>
  )
}

function PreviewStage({ mockup, artwork, targetId, allMockups, viewMode, onSelectMockup, onPreviewError }: { mockup?: Mockup; artwork?: Artwork; targetId?: string; allMockups: Mockup[]; viewMode: ViewMode; onSelectMockup: (id: string) => void; onPreviewError: (error: string) => void }) {
  const [renderedUrl, setRenderedUrl] = useState('')
  useEffect(() => {
    let cancelled = false
    let objectUrl = ''
    if (!mockup || !artwork || !targetId) { setRenderedUrl(mockup?.previewUrl || ''); return }
    renderMockup(mockup, artwork, targetId, 'png').then(({ blob }) => {
      if (cancelled) return
      objectUrl = URL.createObjectURL(blob)
      setRenderedUrl(objectUrl)
    }).catch((error) => { if (!cancelled) onPreviewError(error instanceof Error ? error.message : 'Não foi possível criar a pré-visualização.') })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [mockup, artwork, targetId, onPreviewError])

  if (!mockup) {
    return (
      <div className="preview-empty">
        <div className="preview-artboard">
          <div className="artboard-frame">
            <div className="artboard-topline"><span /><span /><span /></div>
            <div className="artboard-body">
              <div className="artboard-picture"><span className="picture-sun" /><span className="picture-hill hill-one" /><span className="picture-hill hill-two" /></div>
              <div className="artboard-label"><i /><i /><i /></div>
            </div>
          </div>
          <div className="artboard-badge"><Layers2 size={15} /> PSD</div>
        </div>
        <h2>O teu espaço de trabalho começa aqui</h2>
        <p>Adiciona mockups PSD para ver a coleção e preparar as tuas ilustrações.</p>
        <div className="empty-tip"><Sparkles size={15} /> Tudo é processado localmente no teu browser</div>
      </div>
    )
  }

  if (viewMode === 'grid') {
    return <div className="preview-gallery">{allMockups.map((item) => <button className={`gallery-card${item.id === mockup.id ? ' gallery-card-selected' : ''}`} key={item.id} type="button" onClick={() => onSelectMockup(item.id)}><span className="gallery-image"><img src={item.id === mockup.id && renderedUrl ? renderedUrl : item.previewUrl} alt={`Pré-visualização de ${item.file.name}`} /></span><span className="gallery-card-details"><span className="gallery-card-name">{item.file.name.replace(/\.psd$/i, '')}</span><span className="gallery-card-meta">{item.width} × {item.height} px</span></span></button>)}</div>
  }

  return (
    <div className="preview-active">
      <div className="preview-image-wrap"><img src={renderedUrl || mockup.previewUrl} alt={`Pré-visualização de ${mockup.file.name}${artwork ? ` com ${artwork.file.name}` : ''}`} /></div>
      <div className="preview-caption"><span><strong>{mockup.file.name}</strong><small>{mockup.width} × {mockup.height} px</small></span><span className="preview-ready"><Check size={13} /> {artwork ? 'Pré-visualização atualizada' : 'Mockup carregado'}</span></div>
    </div>
  )
}

export default function MockupStudio() {
  const [mockups, setMockups] = useState<Mockup[]>([])
  const [artworks, setArtworks] = useState<Artwork[]>([])
  const [projects, setProjects] = useState<StoredProject[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string>()
  const [selectedMockupId, setSelectedMockupId] = useState<string>()
  const [selectedArtworkId, setSelectedArtworkId] = useState<string>()
  const [format, setFormat] = useState<ExportFormat>('png')
  const [automatic, setAutomatic] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('single')
  const [busy, setBusy] = useState(false)
  const [databaseReady, setDatabaseReady] = useState(false)
  const [storagePersistent, setStoragePersistent] = useState<boolean | null>(null)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [message, setMessage] = useState('')
  const backupInputRef = useRef<HTMLInputElement>(null)

  const activeProject = projects.find((project) => project.id === activeProjectId)
  const selectedMockup = mockups.find((item) => item.id === selectedMockupId) || mockups[0]
  const selectedArtwork = artworks.find((item) => item.id === selectedArtworkId) || artworks[0]
  const readyCount = mockups.filter((item) => item.layers.some((layer) => layerId(layer) === item.targetId)).length
  const exportCount = mockups.length * artworks.length
  const targetLayer = selectedMockup?.layers.find((layer) => layerId(layer) === selectedMockup.targetId)
  const targetMask = targetLayer ? layerMaskCanvas(targetLayer) : undefined
  const targetLayerCanvas = targetLayer ? toCanvas(targetLayer) : undefined
  const targetWidth = targetMask?.width || targetLayerCanvas?.width || Math.max(0, (targetLayer?.mask?.right ?? targetLayer?.right ?? 0) - (targetLayer?.mask?.left ?? targetLayer?.left ?? 0))
  const targetHeight = targetMask?.height || targetLayerCanvas?.height || Math.max(0, (targetLayer?.mask?.bottom ?? targetLayer?.bottom ?? 0) - (targetLayer?.mask?.top ?? targetLayer?.top ?? 0))
  const artworkLabel = useMemo(() => artworks.length === 1 ? '1 ilustração' : `${artworks.length} ilustrações`, [artworks.length])
  const handlePreviewError = useCallback((error: string) => setMessage(error), [])

  useEffect(() => {
    let cancelled = false
    async function restoreProjects() {
      try {
        let stored = await readStoredProjects()
        if (!stored.length) {
          const initial: StoredProject = { id: `project-${Date.now()}`, name: 'Art prints', updatedAt: Date.now(), mockups: [] }
          await saveStoredProject(initial)
          stored = [initial]
        }
        const project = stored[0]
        const restored = await Promise.all(project.mockups.map(async (entry) => parseMockup(new File([entry.data], entry.name, { type: 'image/vnd.adobe.photoshop' }), entry.data, entry.targetId).catch(() => undefined)))
        if (cancelled) return
        setProjects(stored)
        setActiveProjectId(project.id)
        setMockups(restored.filter((item): item is Mockup => Boolean(item)))
        setSelectedMockupId(restored.find((item) => item)?.id)
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : 'Não foi possível abrir os projetos guardados neste browser.')
      } finally {
        if (!cancelled) setDatabaseReady(true)
      }
    }
    restoreProjects()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function requestPersistentStorage() {
      const storage = navigator.storage
      if (!storage?.persisted || !storage.persist) {
        if (!cancelled) setStoragePersistent(false)
        return
      }
      try {
        const alreadyPersistent = await storage.persisted()
        const granted = alreadyPersistent || await storage.persist()
        if (!cancelled) setStoragePersistent(granted)
      } catch {
        if (!cancelled) setStoragePersistent(false)
      }
    }
    void requestPersistentStorage()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!databaseReady || !activeProjectId) return
    const project = projects.find((item) => item.id === activeProjectId)
    if (!project) return
    const record: StoredProject = {
      ...project,
      updatedAt: Date.now(),
      mockups: mockups.map(({ file, data, targetId }) => ({ name: file.name, data, targetId })),
    }
    const timeout = window.setTimeout(() => {
      saveStoredProject(record).then(() => setProjects((current) => current.map((item) => item.id === record.id ? { ...item, updatedAt: record.updatedAt } : item))).catch((error) => setMessage(error instanceof Error ? error.message : 'Não foi possível guardar a coleção localmente.'))
    }, 400)
    return () => window.clearTimeout(timeout)
  }, [mockups, activeProjectId, databaseReady, activeProject?.name])

  async function switchProject(id: string) {
    const project = projects.find((item) => item.id === id)
    if (!project || project.id === activeProjectId || busy) return
    setBusy(true)
    setDatabaseReady(false)
    setMessage('')
    artworks.forEach((artwork) => URL.revokeObjectURL(artwork.previewUrl))
    setArtworks([]); setSelectedArtworkId(undefined)
    try {
      const restored = await Promise.all(project.mockups.map(async (entry) => parseMockup(new File([entry.data], entry.name, { type: 'image/vnd.adobe.photoshop' }), entry.data, entry.targetId).catch(() => undefined)))
      setMockups(restored.filter((item): item is Mockup => Boolean(item)))
      setSelectedMockupId(restored.find((item) => item)?.id)
      setActiveProjectId(project.id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível abrir este projeto.')
    } finally {
      setBusy(false)
      setDatabaseReady(true)
    }
  }

  async function createProject() {
    const name = newProjectName.trim()
    if (!name) return
    const project: StoredProject = { id: `project-${Date.now()}-${Math.random().toString(36).slice(2)}`, name, updatedAt: Date.now(), mockups: [] }
    try {
      await saveStoredProject(project)
      setProjects((current) => [project, ...current])
      artworks.forEach((artwork) => URL.revokeObjectURL(artwork.previewUrl))
      setArtworks([]); setSelectedArtworkId(undefined); setMockups([]); setSelectedMockupId(undefined)
      setActiveProjectId(project.id); setNewProjectName(''); setProjectDialogOpen(false); setMessage('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível criar este projeto.')
    }
  }

  async function removeProject(id: string) {
    const project = projects.find((item) => item.id === id)
    if (!project || projects.length < 2 || busy) return
    const confirmed = window.confirm(`Eliminar a coleção “${project.name}” e os ${project.mockups.length} PSD guardados nela? Esta ação não pode ser anulada.`)
    if (!confirmed) return
    const remaining = projects.filter((item) => item.id !== project.id)
    setDatabaseReady(false)
    try {
      await deleteStoredProject(project.id)
      setProjects(remaining)
      if (project.id === activeProjectId) {
        const next = remaining[0]
        artworks.forEach((artwork) => URL.revokeObjectURL(artwork.previewUrl))
        setArtworks([]); setSelectedArtworkId(undefined)
        const restored = await Promise.all(next.mockups.map(async (entry) => parseMockup(new File([entry.data], entry.name, { type: 'image/vnd.adobe.photoshop' }), entry.data, entry.targetId).catch(() => undefined)))
        setMockups(restored.filter((item): item is Mockup => Boolean(item)))
        setSelectedMockupId(restored.find((item) => item)?.id)
        setActiveProjectId(next.id)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível eliminar esta coleção.')
    } finally {
      setDatabaseReady(true)
    }
  }

  async function exportLibraryBackup() {
    if (busy || !databaseReady) return
    setBusy(true)
    setMessage('A preparar a cópia de segurança…')
    try {
      const savedProjects = await readStoredProjects()
      const stored = savedProjects.map((project) => project.id === activeProjectId
        ? { ...project, updatedAt: Date.now(), mockups: mockups.map(({ file, data, targetId }) => ({ name: file.name, data, targetId })) }
        : project)
      if (!stored.length) throw new Error('Ainda não existem coleções para guardar.')
      const zip = new JSZip()
      const collections = stored.map((project, projectIndex) => ({
        name: project.name,
        mockups: project.mockups.map((mockup, mockupIndex) => {
          const path = `collections/${projectIndex + 1}/${mockupIndex + 1}.psd`
          zip.file(path, mockup.data)
          return { name: mockup.name, targetId: mockup.targetId, path }
        }),
      }))
      const manifest: BackupManifest = { format: 'atelier-mockup-library', version: 1, createdAt: Date.now(), collections }
      zip.file('manifest.json', JSON.stringify(manifest, null, 2))
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `atelier-biblioteca-${new Date().toISOString().slice(0, 10)}.zip`
      anchor.click()
      URL.revokeObjectURL(url)
      setMessage(`Cópia criada com ${stored.length} ${stored.length === 1 ? 'coleção' : 'coleções'} e os respetivos PSDs.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível criar a cópia de segurança.')
    } finally {
      setBusy(false)
    }
  }

  async function importLibraryBackup(files: FileList | null) {
    const file = files?.[0]
    if (!file || busy) return
    setBusy(true)
    setMessage('A restaurar a biblioteca…')
    try {
      const zip = await JSZip.loadAsync(file)
      const manifestFile = zip.file('manifest.json')
      if (!manifestFile) throw new Error('A cópia não contém o ficheiro manifest.json.')
      const manifest = JSON.parse(await manifestFile.async('string')) as Partial<BackupManifest>
      if (manifest.format !== 'atelier-mockup-library' || manifest.version !== 1 || !Array.isArray(manifest.collections)) {
        throw new Error('Este ficheiro não é uma cópia de segurança Atelier válida.')
      }

      const existingProjects = await readStoredProjects()
      const names = new Set(existingProjects.map((project) => project.name.toLocaleLowerCase()))
      const restored: StoredProject[] = []
      for (const [collectionIndex, collection] of manifest.collections.entries()) {
        if (!collection || typeof collection.name !== 'string' || !Array.isArray(collection.mockups)) {
          throw new Error('A cópia contém uma coleção inválida.')
        }
        const baseName = collection.name.trim() || `Coleção ${collectionIndex + 1}`
        let name = baseName
        let suffix = 2
        while (names.has(name.toLocaleLowerCase())) name = `${baseName} (${suffix++})`
        names.add(name.toLocaleLowerCase())
        const mockups: StoredMockup[] = []
        for (const [mockupIndex, entry] of collection.mockups.entries()) {
          const expectedPrefix = `collections/${collectionIndex + 1}/`
          if (!entry || typeof entry.name !== 'string' || typeof entry.path !== 'string' || !entry.path.startsWith(expectedPrefix) || !entry.path.toLowerCase().endsWith('.psd')) {
            throw new Error('A cópia contém um caminho de PSD inválido.')
          }
          const archivedFile = zip.file(entry.path)
          if (!archivedFile || archivedFile.dir) throw new Error(`Falta o PSD “${entry.name}” na cópia.`)
          const data = await archivedFile.async('arraybuffer')
          if (!data.byteLength) throw new Error(`O PSD “${entry.name}” está vazio na cópia.`)
          mockups.push({ name: entry.name, data, targetId: typeof entry.targetId === 'string' ? entry.targetId : '' })
        }
        const project: StoredProject = {
          id: `collection-${Date.now()}-${collectionIndex}-${Math.random().toString(36).slice(2)}`,
          name,
          updatedAt: Date.now(),
          mockups,
        }
        await saveStoredProject(project)
        restored.push(project)
      }
      setProjects((current) => [...restored, ...current])
      setMessage(`Biblioteca restaurada: ${restored.length} ${restored.length === 1 ? 'coleção' : 'coleções'}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível restaurar esta cópia de segurança.')
    } finally {
      setBusy(false)
    }
  }

  async function addMockupFiles(files: FileList | null) {
    if (!files?.length) return
    setMessage('')
    setBusy(true)
    const next: Mockup[] = []
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith('.psd')) {
        setMessage(`${file.name} não é um ficheiro PSD.`)
        continue
      }
      try {
        const data = await file.arrayBuffer()
        const parsed = await parseMockup(file, data)
        if (!automatic) parsed.targetId = parsed.layers[0] ? layerId(parsed.layers[0]) : ''
        next.push(parsed)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Não foi possível ler este ficheiro.'
        setMessage(`${file.name}: ${reason}`)
      }
    }
    if (next.length) {
      setMockups((current) => [...current, ...next])
      setSelectedMockupId((current) => current || next[0].id)
    }
    setBusy(false)
  }

  function addArtworkFiles(files: FileList | null) {
    if (!files?.length) return
    const accepted = Array.from(files).filter((file) => file.type.startsWith('image/'))
    const newArtworks = accepted.map((file) => ({ id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`, file, previewUrl: URL.createObjectURL(file) }))
    setArtworks((current) => [...current, ...newArtworks])
    setSelectedArtworkId((current) => current || newArtworks[0]?.id)
    if (accepted.length !== files.length) setMessage('Alguns ficheiros foram ignorados. Escolhe imagens PNG, JPG ou WebP.')
  }

  function removeMockup(id: string) {
    setMockups((current) => {
      const next = current.filter((item) => item.id !== id)
      if (selectedMockupId === id) setSelectedMockupId(next[0]?.id)
      return next
    })
  }

  function removeArtwork(id: string) {
    setArtworks((current) => {
      const removed = current.find((item) => item.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      const next = current.filter((item) => item.id !== id)
      if (selectedArtworkId === id) setSelectedArtworkId(next[0]?.id)
      return next
    })
  }

  function chooseTarget(mockupId: string, targetId: string) {
    setMockups((current) => current.map((item) => item.id === mockupId ? { ...item, targetId } : item))
  }

  function toggleAutomatic() {
    setAutomatic((current) => {
      const next = !current
      if (next) setMockups((items) => items.map((item) => ({ ...item, targetId: findTarget(item.layers) || item.targetId })))
      return next
    })
  }

  async function exportAll() {
    if (!mockups.length || !artworks.length || busy) return
    setBusy(true)
    setMessage('A preparar os ficheiros…')
    try {
      const zip = new JSZip()
      for (const [mockupIndex, mockup] of mockups.entries()) {
        for (const [artworkIndex, artwork] of artworks.entries()) {
          const targetId = mockup.targetId || findTarget(mockup.layers)
          if (!targetId) continue
          const { blob } = await renderMockup(mockup, artwork, targetId, format)
          const mockupName = mockup.file.name.replace(/\.psd$/i, '')
          const artworkName = artwork.file.name.replace(/\.[^.]+$/, '')
          zip.file(`${String(mockupIndex + 1).padStart(2, '0')}_${mockupName}/${String(artworkIndex + 1).padStart(2, '0')}_${artworkName}.${format}`, blob)
        }
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `mockup-studio-${format}.zip`
      anchor.click()
      URL.revokeObjectURL(url)
      setMessage(`${exportCount} ${exportCount === 1 ? 'ficheiro exportado' : 'ficheiros exportados'} em ${format.toUpperCase()}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Ocorreu um erro durante a exportação.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="studio-shell">
      <header className="topbar">
        <a className="brand" href="#inicio" aria-label="Atelier — início">
          <span className="brand-mark"><Layers2 size={19} strokeWidth={1.8} /></span>
          <span className="brand-name">atelier<span>.</span></span>
        </a>
        <div className="topbar-center"><span className="local-indicator" /> Ferramenta local <span className="topbar-divider">/</span> Ficheiros privados</div>
        <div className="topbar-actions"><span className="help-copy">A tua bancada criativa</span><span className="avatar-mark">A</span></div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-section-heading"><span>AS MINHAS COLEÇÕES</span><button type="button" className="icon-button" aria-label="Criar coleção" title="Criar coleção" onClick={() => setProjectDialogOpen(true)}><Plus size={16} /></button></div>
          <nav className="collection-nav" aria-label="Coleções">
            {projects.map((project) => (
              <div className={`collection-nav-row${project.id === activeProjectId ? ' collection-nav-row-active' : ''}`} key={project.id}>
                <button className="collection-nav-button" type="button" title={project.name} aria-current={project.id === activeProjectId ? 'page' : undefined} disabled={busy && project.id !== activeProjectId} onClick={() => void switchProject(project.id)}>
                  <FolderOpen className="collection-nav-icon" size={16} />
                  <span className="collection-nav-copy"><strong>{project.name}</strong><small>{project.mockups.length} {project.mockups.length === 1 ? 'mockup' : 'mockups'}</small></span>
                  <span className="collection-nav-count">{project.mockups.length}</span>
                </button>
                {projects.length > 1 && <button className="collection-remove" type="button" aria-label={`Eliminar coleção ${project.name}`} title={`Eliminar coleção ${project.name}`} disabled={busy} onClick={() => void removeProject(project.id)}><X size={13} /></button>}
              </div>
            ))}
          </nav>
          <div className="sidebar-list-label">MOCKUPS <span>{mockups.length.toString().padStart(2, '0')}</span></div>
          {mockups.length ? <div className="mockup-list">{mockups.map((mockup) => (
            <button className={`mockup-list-item${selectedMockup?.id === mockup.id ? ' selected' : ''}`} key={mockup.id} onClick={() => setSelectedMockupId(mockup.id)} type="button">
              <span className="list-thumb"><img src={mockup.previewUrl} alt="" /></span>
              <span className="list-file-info"><strong>{mockup.file.name.replace(/\.psd$/i, '')}</strong><small>{mockup.width} × {mockup.height}</small></span>
              <span className="list-dot" />
            </button>
          ))}</div> : <div className="sidebar-empty">Adiciona PSDs a esta coleção.</div>}
          <div className="sidebar-upload" id="mockup-upload-trigger">
            <Dropzone title="Adicionar mockups" subtitle="Arrasta ficheiros .psd ou procura" accept=".psd,image/vnd.adobe.photoshop" multiple onFiles={addMockupFiles} compact />
          </div>
          <div className="sidebar-footer"><span className="privacy-icon"><Check size={13} /></span><span><strong>{storagePersistent ? 'Armazenamento protegido' : 'Guardado neste browser'}</strong><small>Os PSDs não saem do teu dispositivo.</small></span></div>
          <div className="sidebar-backup-actions">
            <button type="button" onClick={() => void exportLibraryBackup()} disabled={busy || !databaseReady}><ArrowDownToLine size={13} /> Fazer cópia</button>
            <button type="button" onClick={() => backupInputRef.current?.click()} disabled={busy}><Upload size={13} /> Restaurar</button>
            <input ref={backupInputRef} className="sr-only" type="file" accept=".zip,application/zip" aria-label="Selecionar cópia da biblioteca" onChange={(event) => { void importLibraryBackup(event.target.files); event.target.value = '' }} />
          </div>
        </aside>

        <section className="main-panel" id="inicio">
          <div className="page-heading">
            <div><div className="eyebrow"><span>WORKSPACE</span><span className="eyebrow-slash">/</span><span>{activeProject?.name || 'MOCKUP STUDIO'}</span></div><h1>Mockup studio<span>.</span></h1><p>As tuas ilustrações, no lugar certo.</p></div>
            <div className="page-actions"><span className="collection-status"><span />{mockups.length ? `${mockups.length} mockup${mockups.length === 1 ? '' : 's'} nesta coleção` : 'Coleção guardada localmente'}</span><button type="button" className="button button-secondary" onClick={() => document.querySelector<HTMLInputElement>('.sidebar-upload input')?.click()}><Plus size={16} /> Adicionar PSD</button></div>
          </div>

          <div className="stepper" aria-label="Etapas de trabalho">
            <div className={`step-item${mockups.length ? ' step-complete' : ' step-current'}`}><span className="step-number">{mockups.length ? <Check size={13} /> : '01'}</span><span>Mockups</span></div><span className="step-line" />
            <div className={`step-item${artworks.length ? ' step-complete' : mockups.length ? ' step-current' : ''}`}><span className="step-number">{artworks.length ? <Check size={13} /> : '02'}</span><span>Ilustrações</span></div><span className="step-line" />
            <div className={`step-item${mockups.length && artworks.length ? ' step-current' : ''}`}><span className="step-number">03</span><span>Exportar</span></div>
          </div>

          <div className="work-area">
            <div className="preview-column">
              <div className="section-heading"><div><span className="section-kicker">01 — PRÉ-VISUALIZAÇÃO</span><h2>{viewMode === 'single' ? 'Mockup individual' : 'Toda a coleção'}</h2></div><div className="view-toggle" role="group" aria-label="Modo de visualização"><button type="button" aria-pressed={viewMode === 'single'} className={viewMode === 'single' ? 'view-toggle-active' : ''} onClick={() => setViewMode('single')}>Individual</button><button type="button" aria-pressed={viewMode === 'grid'} className={viewMode === 'grid' ? 'view-toggle-active' : ''} onClick={() => setViewMode('grid')}>Ver grupo</button></div></div>
              <div className={`preview-card${viewMode === 'grid' ? ' preview-card-gallery' : ''}`}><PreviewStage mockup={selectedMockup} artwork={selectedArtwork} targetId={selectedMockup?.targetId} allMockups={mockups} viewMode={viewMode} onSelectMockup={setSelectedMockupId} onPreviewError={handlePreviewError} /></div>
              {message && <div className={`status-message${message.includes('exportados') ? ' success-message' : ''}`} role="status">{message}</div>}
              <div className="collection-strip"><div className="strip-heading"><div><span className="section-kicker">A TUA COLEÇÃO</span><h3>Mockups <span>{mockups.length.toString().padStart(2, '0')}</span></h3></div><button type="button" className="text-button" onClick={() => setViewMode('grid')}>Ver todos <ChevronDown size={14} /></button></div>
                {mockups.length ? <div className="collection-grid">{mockups.map((mockup) => <div key={mockup.id} className={`collection-card${selectedMockup?.id === mockup.id ? ' collection-card-active' : ''}`} role="button" tabIndex={0} onClick={() => setSelectedMockupId(mockup.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedMockupId(mockup.id) }}><span className="collection-thumb"><img src={mockup.previewUrl} alt="" /><span className="file-type">PSD</span><button type="button" className="remove-item" aria-label={`Remover ${mockup.file.name}`} onClick={(event) => { event.stopPropagation(); removeMockup(mockup.id) }} onKeyDown={(event) => event.stopPropagation()}><X size={13} /></button></span><span className="collection-name">{mockup.file.name.replace(/\.psd$/i, '')}</span><span className="collection-meta">{mockup.width} × {mockup.height} px</span></div>)}<Dropzone title="Adicionar" subtitle="" accept=".psd,image/vnd.adobe.photoshop" multiple onFiles={addMockupFiles} compact /></div> : <div className="collection-empty"><div className="collection-empty-icon"><FileImage size={18} /></div><span><strong>Ainda sem mockups</strong><small>Adiciona um ficheiro PSD para começar a coleção.</small></span><button type="button" onClick={() => document.querySelector<HTMLInputElement>('.sidebar-upload input')?.click()}>Escolher ficheiros <Plus size={14} /></button></div>}
              </div>
            </div>

            <aside className="settings-column">
              <div className="section-heading settings-heading"><div><span className="section-kicker">02 — PREPARAR</span><h2>Configuração</h2></div><span className="settings-status"><span /> Pronto</span></div>
              <div className="settings-card">
                <div className="setting-block"><div className="setting-title-row"><div><span className="setting-index">A</span><div><h3>Camada de destino</h3><p>Onde inserir a ilustração</p></div></div></div>
                  {selectedMockup ? <label className="select-wrap"><span className="sr-only">Selecionar camada de destino</span><select value={selectedMockup.targetId} onChange={(event) => chooseTarget(selectedMockup.id, event.target.value)}>{selectedMockup.layers.map((layer) => <option key={layerId(layer)} value={layerId(layer)}>{layer.name || 'Camada sem nome'}</option>)}</select><ChevronDown size={15} /></label> : <div className="setting-placeholder">Adiciona um PSD para escolher a camada.</div>}
                  <button type="button" className={`auto-detect${automatic ? ' auto-active' : ''}`} onClick={toggleAutomatic}><span className="auto-icon"><Sparkles size={14} /></span><span><strong>Deteção automática</strong><small>{automatic ? 'Ativa · procura “mask”, “art” e “design”' : 'Desativada · seleção manual'}</small></span><span className="switch-track"><i /></span></button>
                  {selectedMockup && <div className="layer-info"><Layers2 size={14} /><span>{targetLayer?.name || 'Camada selecionada'}</span><span>{targetWidth} × {targetHeight} px</span></div>}
                </div>
                <div className="settings-divider" />
                <div className="setting-block"><div className="setting-title-row"><div><span className="setting-index">B</span><div><h3>Ilustrações</h3><p>{artworks.length ? `${artworkLabel} adicionadas` : 'Adiciona os ficheiros para aplicar'}</p></div></div>{artworks.length > 0 && <span className="artwork-count">{artworks.length.toString().padStart(2, '0')}</span>}</div>
                  {artworks.length ? <div className="artwork-list">{artworks.map((artwork) => <div className={`artwork-row${selectedArtwork?.id === artwork.id ? ' artwork-selected' : ''}`} key={artwork.id} role="button" tabIndex={0} onClick={() => setSelectedArtworkId(artwork.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedArtworkId(artwork.id) }}><span className="artwork-thumb"><img src={artwork.previewUrl} alt="" /></span><span className="artwork-name"><strong>{artwork.file.name}</strong><small>{(artwork.file.size / 1024 / 1024).toFixed(1)} MB</small></span>{selectedArtwork?.id === artwork.id && <Check className="artwork-check" size={16} />}<button type="button" className="remove-artwork" aria-label={`Remover ${artwork.file.name}`} onClick={(event) => { event.stopPropagation(); removeArtwork(artwork.id) }} onKeyDown={(event) => event.stopPropagation()}><X size={13} /></button></div>)}</div> : <div className="artwork-empty"><ImagePlus size={18} /><span>As tuas ilustrações aparecem aqui.</span></div>}
                  <Dropzone title={artworks.length ? 'Adicionar mais ilustrações' : 'Carregar ilustrações'} subtitle="PNG, JPG ou WebP · várias de uma vez" accept="image/png,image/jpeg,image/webp" multiple onFiles={addArtworkFiles} compact />
                </div>
                <div className="settings-divider" />
                <div className="setting-block export-block"><div className="setting-title-row"><div><span className="setting-index">C</span><div><h3>Exportação</h3><p>Ficheiros prontos para partilhar</p></div></div></div>
                  <div className="format-select" role="group" aria-label="Formato de exportação"><button className={format === 'png' ? 'format-active' : ''} onClick={() => setFormat('png')} type="button"><span className="format-radio" />PNG<span className="format-detail">Transparência</span></button><button className={format === 'jpg' ? 'format-active' : ''} onClick={() => setFormat('jpg')} type="button"><span className="format-radio" />JPG<span className="format-detail">Qualidade 96%</span></button></div>
                  <div className="export-summary"><span><Layers2 size={14} /> {mockups.length} mockups × {artworks.length} ilustrações</span><strong>{exportCount} {exportCount === 1 ? 'ficheiro' : 'ficheiros'}</strong></div>
                  <button className="button button-primary export-button" type="button" disabled={!mockups.length || !artworks.length || busy || readyCount === 0} onClick={exportAll}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}{busy ? 'A preparar…' : 'Exportar coleção'}<span className="button-format">{format.toUpperCase()}</span></button>
                  <p className="export-note">Alta resolução · um ZIP organizado por mockup</p>
                </div>
              </div>
              <div className="privacy-note"><span><Check size={14} /></span><p><strong>PSD guardados neste browser.</strong> Faz uma cópia de segurança ZIP e restaura-a noutro dispositivo. As ilustrações continuam temporárias.</p></div>
            </aside>
          </div>
          <footer className="workspace-footer"><span>atelier<span className="footer-dot">.</span> <span className="footer-version">MOCKUP STUDIO</span></span><span>{mockups.length} PSD <i /> {artworks.length} imagens prontas</span></footer>
        </section>
      </div>
      {projectDialogOpen && <div className="project-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectDialogOpen(false) }}><section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title"><button type="button" className="dialog-close" aria-label="Fechar" onClick={() => setProjectDialogOpen(false)}><X size={16} /></button><span className="dialog-eyebrow">NOVA COLEÇÃO</span><h2 id="new-project-title">Criar coleção</h2><p>Organiza os teus mockups por produto, campanha ou tema.</p><form onSubmit={(event) => { event.preventDefault(); void createProject() }}><label htmlFor="project-name">Nome da coleção</label><input id="project-name" autoFocus maxLength={50} placeholder="Ex.: T-shirts" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} /><div className="dialog-actions"><button type="button" className="button button-secondary" onClick={() => setProjectDialogOpen(false)}>Cancelar</button><button type="submit" className="button button-primary" disabled={!newProjectName.trim()}>Criar coleção</button></div></form></section></div>}
      {busy && <div className="loading-overlay" aria-live="polite"><LoaderCircle className="spin" size={22} /><span>A processar ficheiros no browser…</span></div>}
    </main>
  )
}

export { Dropzone }

