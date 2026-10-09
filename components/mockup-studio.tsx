'use client'

import { useMemo, useRef, useState } from 'react'
import { getCompositeCanvas, readPsd } from 'ag-psd'
import JSZip from 'jszip'
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  FileImage,
  FilePlus2,
  Images,
  Layers3,
  LoaderCircle,
  MousePointer2,
  Paintbrush2,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'

type PsdLayer = {
  name?: string
  canvas?: HTMLCanvasElement
  left?: number
  top?: number
  right?: number
  bottom?: number
  hidden?: boolean
  opacity?: number
  children?: PsdLayer[]
}

type PsdDocument = {
  width: number
  height: number
  children?: PsdLayer[]
}

type Mockup = {
  id: string
  file: File
  name: string
  width: number
  height: number
  layers: PsdLayer[]
  selectedLayer: string
  previewUrl: string
}

type Artwork = { id: string; file: File; name: string; url: string }
type ExportFormat = 'png' | 'jpg'

const maskWords = /mask|máscara|mascara|artwork|design|replace|substitut|smart object|arte|estampa|print/i
const backgroundWords = /background|fundo|mockup|base|shadow|sombra/i

function flattenLayers(layers: PsdLayer[] = []): PsdLayer[] {
  return layers.flatMap((layer) => [layer, ...flattenLayers(layer.children ?? [])])
}

function findMask(layers: PsdLayer[]) {
  const available = flattenLayers(layers).filter((layer) => layer.canvas && !layer.hidden)
  return (
    available.find((layer) => maskWords.test(layer.name ?? '')) ??
    available.find((layer) => !backgroundWords.test(layer.name ?? '')) ??
    available[0]
  )
}

function layerId(layer: PsdLayer, index: number) {
  return `${layer.name || 'layer'}-${index}`
}

function layerOptions(layers: PsdLayer[]) {
  return flattenLayers(layers)
    .filter((layer) => layer.canvas && !layer.hidden)
    .map((layer, index) => ({ id: layerId(layer, index), label: layer.name || `Camada ${index + 1}`, layer }))
}

function fitImage(ctx: CanvasRenderingContext2D, image: CanvasImageSource, sourceWidth: number, sourceHeight: number, x: number, y: number, width: number, height: number) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight)
}

function renderMockup(mockup: Pick<Mockup, 'width' | 'height' | 'layers' | 'selectedLayer'>, artwork?: HTMLImageElement) {
  const canvas = document.createElement('canvas')
  canvas.width = mockup.width
  canvas.height = mockup.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Não foi possível criar a imagem de pré-visualização.')

  const layers = flattenLayers(mockup.layers)
  const options = layerOptions(mockup.layers)
  const target = options.find((item) => item.id === mockup.selectedLayer)?.layer
  const targetIndex = layers.indexOf(target as PsdLayer)

  if (!target) {
    const composite = layers.find((layer) => layer.canvas)?.canvas
    if (composite) ctx.drawImage(composite, 0, 0)
    return canvas
  }

  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index]
    if (!layer.canvas || layer.hidden || index === targetIndex) continue
    ctx.globalAlpha = Math.max(0, Math.min(1, (layer.opacity ?? 255) / 255))
    ctx.drawImage(layer.canvas, layer.left ?? 0, layer.top ?? 0)
  }
  ctx.globalAlpha = 1

  if (artwork && target.canvas) {
    const x = target.left ?? 0
    const y = target.top ?? 0
    const boundsWidth = target.right && target.left !== undefined ? target.right - target.left : target.canvas.width
    const boundsHeight = target.bottom && target.top !== undefined ? target.bottom - target.top : target.canvas.height
    const artworkCanvas = document.createElement('canvas')
    artworkCanvas.width = mockup.width
    artworkCanvas.height = mockup.height
    const artworkContext = artworkCanvas.getContext('2d')
    if (artworkContext) {
      fitImage(artworkContext, artwork, artwork.naturalWidth, artwork.naturalHeight, x, y, boundsWidth, boundsHeight)
      artworkContext.globalCompositeOperation = 'destination-in'
      artworkContext.drawImage(target.canvas, x, y)
      ctx.drawImage(artworkCanvas, 0, 0)
    }
  }
  return canvas
}

function canvasBlob(canvas: HTMLCanvasElement, format: ExportFormat) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Não foi possível exportar esta imagem.'))), format === 'jpg' ? 'image/jpeg' : 'image/png', 0.96)
  })
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Não foi possível abrir esta ilustração.'))
    image.src = url
  })
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function safeName(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-').trim() || 'mockup'
}

export function MockupStudio() {
  const psdInput = useRef<HTMLInputElement>(null)
  const artworkInput = useRef<HTMLInputElement>(null)
  const [mockups, setMockups] = useState<Mockup[]>([])
  const [artworks, setArtworks] = useState<Artwork[]>([])
  const [activeMockup, setActiveMockup] = useState<string | null>(null)
  const [format, setFormat] = useState<ExportFormat>('png')
  const [autoDetect, setAutoDetect] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  const currentMockup = mockups.find((mockup) => mockup.id === activeMockup) ?? mockups[0]
  const totalExports = mockups.length * artworks.length
  const currentArtwork = artworks[0]
  const currentPreview = useMemo(() => currentMockup?.previewUrl, [currentMockup?.previewUrl])

  async function addMockups(files: FileList | File[]) {
    setError('')
    const psdFiles = Array.from(files).filter((file) => file.name.toLowerCase().endsWith('.psd'))
    if (!psdFiles.length) {
      setError('Escolha ficheiros PSD para adicionar à coleção.')
      return
    }
    setBusy(true)
    setProgress('A ler os mockups…')
    const next: Mockup[] = []
    try {
      for (const file of psdFiles) {
        const document = readPsd(await file.arrayBuffer()) as unknown as PsdDocument
        const layers = document.children ?? []
        const detected = findMask(layers)
        const selectedLayer = detected ? layerOptions(layers).find((item) => item.layer === detected)?.id ?? '' : ''
        const composite = getCompositeCanvas(document as never)
        const previewUrl = composite?.toDataURL('image/png') ?? ''
        next.push({ id: crypto.randomUUID(), file, name: file.name, width: document.width, height: document.height, layers, selectedLayer, previewUrl })
      }
      setMockups((existing) => [...existing, ...next])
      if (!activeMockup && next[0]) setActiveMockup(next[0].id)
      setProgress('')
    } catch {
      setError('Não foi possível ler um dos PSD. Confirma se está em RGB, 8 bits e se não é um ficheiro PSB.')
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  function addArtworks(files: FileList | File[]) {
    setError('')
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (!images.length) {
      setError('Escolha ficheiros de imagem, como PNG, JPG ou WEBP.')
      return
    }
    setArtworks((existing) => [
      ...existing,
      ...images.map((file) => ({ id: crypto.randomUUID(), file, name: file.name, url: URL.createObjectURL(file) })),
    ])
  }

  function setTarget(mockupId: string, layerIdValue: string) {
    setMockups((existing) => existing.map((mockup) => {
      if (mockup.id !== mockupId) return mockup
      const updated = { ...mockup, selectedLayer: layerIdValue }
      try {
        updated.previewUrl = renderMockup(updated).toDataURL('image/png')
      } catch { /* The export path reports rendering errors to the user. */ }
      return updated
    }))
  }

  function removeArtwork(id: string) {
    setArtworks((existing) => {
      const item = existing.find((artwork) => artwork.id === id)
      if (item) URL.revokeObjectURL(item.url)
      return existing.filter((artwork) => artwork.id !== id)
    })
  }

  function removeMockup(id: string) {
    setMockups((existing) => {
      const remaining = existing.filter((mockup) => mockup.id !== id)
      setActiveMockup((active) => active === id ? remaining[0]?.id ?? null : active)
      return remaining
    })
  }

  async function exportAll() {
    if (!mockups.length || !artworks.length) return
    setBusy(true)
    setError('')
    const zip = new JSZip()
    let completed = 0
    try {
      for (const mockup of mockups) {
        const target = layerOptions(mockup.layers).find((layer) => layer.id === mockup.selectedLayer)
        if (!target) continue
        for (const artwork of artworks) {
          setProgress(`A preparar ${completed + 1} de ${totalExports}…`)
          const image = await loadImage(artwork.url)
          const canvas = renderMockup(mockup, image)
          const blob = await canvasBlob(canvas, format)
          const extension = format === 'jpg' ? 'jpg' : 'png'
          zip.file(`${safeName(mockup.name)}_${safeName(artwork.name)}.${extension}`, blob)
          completed += 1
        }
      }
      if (!completed) throw new Error('Não foi possível encontrar a camada de clipping mask nos mockups.')
      const archive = await zip.generateAsync({ type: 'blob' })
      downloadBlob(archive, `mockups-ilustrados-${format}.zip`)
      setProgress('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Ocorreu um erro ao exportar os ficheiros.')
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  async function exportCurrent() {
    if (!currentMockup || !currentArtwork) return
    setBusy(true)
    setError('')
    try {
      const canvas = renderMockup(currentMockup, await loadImage(currentArtwork.url))
      downloadBlob(await canvasBlob(canvas, format), `${safeName(currentMockup.name)}_${safeName(currentArtwork.name)}.${format}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Ocorreu um erro ao exportar a imagem.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="studio-shell">
      <header className="topbar">
        <a className="brand" href="#inicio" aria-label="Ateliê Mockup, início">
          <span className="brand-mark"><Paintbrush2 size={19} strokeWidth={1.8} /></span>
          <span>atelier<span className="brand-light">mockup</span></span>
        </a>
        <div className="topbar-divider" />
        <span className="topbar-context">O teu estúdio local</span>
        <div className="topbar-right">
          <span className="privacy-note"><span className="privacy-dot" /> Os ficheiros não saem do teu dispositivo</span>
          <button type="button" className="help-button" aria-label="Ajuda"><CircleHelp size={18} /></button>
        </div>
      </header>

      <div className="studio-layout">
        <aside className="sidebar">
          <div className="sidebar-label">WORKSPACE</div>
          <button className="nav-item nav-active" type="button"><Images size={17} /> A minha coleção <span className="nav-count">{mockups.length}</span></button>
          <button className="nav-item" type="button" onClick={() => artworkInput.current?.click()}><Paintbrush2 size={17} /> Ilustrações <span className="nav-count">{artworks.length}</span></button>

          <div className="sidebar-section-head">
            <span>MOCKUPS PSD</span>
            <button type="button" className="icon-button subtle-icon" aria-label="Adicionar mockup" onClick={() => psdInput.current?.click()}><Plus size={17} /></button>
          </div>
          <div className="mockup-nav-list">
            {mockups.map((mockup, index) => (
              <button type="button" key={mockup.id} onClick={() => setActiveMockup(mockup.id)} className={`mockup-nav-item ${currentMockup?.id === mockup.id ? 'selected' : ''}`}>
                <span className="nav-thumbnail">{mockup.previewUrl ? <img src={mockup.previewUrl} alt="" /> : <FileImage size={16} />}</span>
                <span className="nav-name">{mockup.name}</span>
                <span className="nav-index">{String(index + 1).padStart(2, '0')}</span>
              </button>
            ))}
          </div>

          {!mockups.length && (
            <div className="sidebar-empty">A tua coleção começa com um mockup PSD.</div>
          )}

          <div className="sidebar-bottom">
            <div className="local-card"><span className="local-icon"><Sparkles size={16} /></span><div><strong>Feito para criar</strong><p>O teu trabalho fica sempre local.</p></div></div>
            <span className="version-note">ATELIER MOCKUP · 01</span>
          </div>
        </aside>

        <section className="workspace" id="inicio">
          <div className="page-heading">
            <div>
              <div className="eyebrow">ESTÚDIO DE MOCKUPS <span>·</span> WORKSPACE</div>
              <h1>A tua coleção, <em>com vida.</em></h1>
              <p className="heading-copy">Aplica as tuas ilustrações nos mockups e prepara tudo para exportar.</p>
            </div>
            <button className="button button-dark" type="button" onClick={() => psdInput.current?.click()}><Plus size={17} /> Adicionar mockup</button>
          </div>

          <div className="workflow-bar" aria-label="Etapas do fluxo de trabalho">
            <div className={`workflow-step ${mockups.length ? 'step-complete' : 'step-current'}`}><span className="step-number">{mockups.length ? <Check size={13} /> : '01'}</span><span>Mockups PSD</span></div>
            <ArrowRight size={15} className="workflow-arrow" />
            <div className={`workflow-step ${artworks.length ? 'step-complete' : mockups.length ? 'step-current' : ''}`}><span className="step-number">{artworks.length ? <Check size={13} /> : '02'}</span><span>Ilustrações</span></div>
            <ArrowRight size={15} className="workflow-arrow" />
            <div className={`workflow-step ${totalExports ? 'step-current' : ''}`}><span className="step-number">03</span><span>Exportar</span></div>
            <span className="workflow-private"><span className="privacy-dot" /> Processamento privado</span>
          </div>

          <div className="content-grid">
            <div className="main-column">
              <section className="section-block">
                <div className="section-heading">
                  <div><span className="section-kicker">01 — A BASE</span><h2>Mockups PSD</h2></div>
                  <span className="count-label">{mockups.length} {mockups.length === 1 ? 'ficheiro' : 'ficheiros'}</span>
                </div>
                {!mockups.length ? (
                  <button className="upload-panel psd-drop" type="button" onClick={() => psdInput.current?.click()}>
                    <span className="upload-icon"><Layers3 size={21} /></span>
                    <span className="upload-title">Adiciona os teus mockups</span>
                    <span className="upload-description">Arrasta ficheiros PSD para aqui ou <b>escolhe no computador</b></span>
                    <span className="upload-footnote">PSD · RGB · 8 bits por canal</span>
                  </button>
                ) : (
                  <div className="mockup-grid">
                    {mockups.map((mockup, index) => {
                      const options = layerOptions(mockup.layers)
                      const detected = findMask(mockup.layers)
                      const selected = options.find((option) => option.id === mockup.selectedLayer)
                      return (
                        <article className={`mockup-card ${currentMockup?.id === mockup.id ? 'card-selected' : ''}`} key={mockup.id}>
                          <button type="button" className="mockup-preview" onClick={() => setActiveMockup(mockup.id)} aria-label={`Pré-visualizar ${mockup.name}`}>
                            {mockup.previewUrl && !artworks.length ? <img src={mockup.previewUrl} alt={`Pré-visualização de ${mockup.name}`} /> : (
                              <div className="preview-stage">
                                <span className="preview-badge">{String(index + 1).padStart(2, '0')}</span>
                                {artworks.length && currentMockup?.id === mockup.id && currentPreview ? <img src={currentPreview} alt={`Mockup ${mockup.name}`} /> : mockup.previewUrl ? <img src={mockup.previewUrl} alt={`Pré-visualização de ${mockup.name}`} /> : <FileImage size={28} />}
                                {currentArtwork && <img className="artwork-overlay" src={currentArtwork.url} alt="" />}
                                <span className="preview-dimensions">{mockup.width} × {mockup.height}</span>
                              </div>
                            )}
                            {artworks.length > 0 && mockup.previewUrl && <span className="preview-art" style={{ backgroundImage: `url(${currentArtwork?.url})` }} aria-hidden="true" />}
                          </button>
                          <div className="mockup-card-info">
                            <button className="mockup-title-button" type="button" onClick={() => setActiveMockup(mockup.id)}><strong>{mockup.name}</strong></button>
                            <button className="remove-button" type="button" aria-label={`Remover ${mockup.name}`} onClick={() => removeMockup(mockup.id)}><X size={15} /></button>
                            <span className="mockup-meta">{mockup.width} × {mockup.height} px</span>
                          </div>
                          <label className="layer-select-label" htmlFor={`target-${mockup.id}`}><Layers3 size={13} /> CAMADA DE DESTINO</label>
                          <div className="select-wrap">
                            <select id={`target-${mockup.id}`} value={mockup.selectedLayer} onChange={(event) => setTarget(mockup.id, event.target.value)}>
                              {!options.length && <option value="">Nenhuma camada disponível</option>}
                              {options.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                            </select>
                            <ChevronDown size={14} aria-hidden="true" />
                          </div>
                          <span className={`detection-note ${autoDetect && selected?.layer === detected ? 'detected' : ''}`}>
                            {autoDetect && selected?.layer === detected ? <><Sparkles size={12} /> Detetada automaticamente</> : <><MousePointer2 size={12} /> Seleciona a camada manualmente</>}
                          </span>
                        </article>
                      )
                    })}
                    <button type="button" className="add-card" onClick={() => psdInput.current?.click()}><span className="add-card-icon"><Plus size={18} /></span><span>Adicionar mockup</span></button>
                  </div>
                )}
              </section>

              <section className="section-block artwork-section">
                <div className="section-heading">
                  <div><span className="section-kicker">02 — A TUA ARTE</span><h2>Ilustrações</h2></div>
                  <span className="count-label">{artworks.length} {artworks.length === 1 ? 'ficheiro' : 'ficheiros'}</span>
                </div>
                {!artworks.length ? (
                  <button className="upload-panel art-drop" type="button" onClick={() => artworkInput.current?.click()}>
                    <span className="upload-icon art-upload-icon"><FilePlus2 size={20} /></span>
                    <span className="upload-title">Carrega várias ilustrações de uma vez</span>
                    <span className="upload-description">PNG, JPG ou WEBP · Podes selecionar vários ficheiros</span>
                    <span className="upload-action"><Upload size={14} /> Escolher ilustrações</span>
                  </button>
                ) : (
                  <div className="artwork-list">
                    {artworks.map((artwork) => (
                      <div className="artwork-item" key={artwork.id}>
                        <img src={artwork.url} alt={`Pré-visualização de ${artwork.name}`} />
                        <span className="artwork-name">{artwork.name}</span>
                        <span className="artwork-format">{artwork.file.type.split('/')[1]?.toUpperCase()}</span>
                        <button className="remove-button" type="button" aria-label={`Remover ${artwork.name}`} onClick={() => removeArtwork(artwork.id)}><Trash2 size={14} /></button>
                      </div>
                    ))}
                    <button className="add-artwork-button" type="button" onClick={() => artworkInput.current?.click()}><Plus size={15} /> Adicionar mais ilustrações</button>
                  </div>
                )}
              </section>
            </div>

            <aside className="export-panel">
              <div className="export-panel-head"><span className="export-mark"><ArrowDownToLine size={17} /></span><span className="export-status">PRONTO PARA EXPORTAR</span></div>
              <h2>Preparar<br />exportação</h2>
              <p className="export-description">Cria imagens prontas para partilhar, em tamanho original.</p>

              <div className="export-stat"><span>Mockups</span><strong>{String(mockups.length).padStart(2, '0')}</strong></div>
              <div className="export-stat"><span>Ilustrações</span><strong>{String(artworks.length).padStart(2, '0')}</strong></div>
              <div className="export-stat export-total"><span>Ficheiros finais</span><strong>{String(totalExports).padStart(2, '0')}</strong></div>

              <div className="export-option-label">FORMATO DE IMAGEM</div>
              <div className="format-switch" role="group" aria-label="Formato de exportação">
                <button type="button" className={format === 'png' ? 'format-active' : ''} onClick={() => setFormat('png')}><span>PNG</span><small>Sem perdas</small></button>
                <button type="button" className={format === 'jpg' ? 'format-active' : ''} onClick={() => setFormat('jpg')}><span>JPG</span><small>Alta qualidade</small></button>
              </div>

              <label className="auto-detect-toggle"><input type="checkbox" checked={autoDetect} onChange={(event) => setAutoDetect(event.target.checked)} /><span className="toggle-track"><span /></span><span><b>Detetar camada automaticamente</b><small>Procura nomes como "mask" ou "design"</small></span></label>

              <button className="export-button" type="button" onClick={exportAll} disabled={busy || !totalExports}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowDownToLine size={17} />}
                {busy ? progress || 'A preparar…' : 'Exportar coleção'}
              </button>
              <button type="button" className="export-single-button" onClick={exportCurrent} disabled={busy || !currentMockup || !currentArtwork}>Exportar apenas o mockup selecionado</button>
              <p className="zip-note">Os ficheiros são entregues num único ZIP. A resolução mantém-se original.</p>
            </aside>
          </div>
          {error && <div className="error-message" role="alert"><span>{error}</span><button type="button" aria-label="Fechar aviso" onClick={() => setError('')}><X size={16} /></button></div>}
          {progress && !busy && <div className="progress-message" role="status">{progress}</div>}
          <footer className="workspace-footer"><span>Um espaço de trabalho para as tuas ideias.</span><span>Processamento feito localmente <span className="footer-heart">·</span> Sem uploads para a nuvem</span></footer>
        </section>
      </div>

      <input ref={psdInput} className="visually-hidden" type="file" accept=".psd,image/vnd.adobe.photoshop" multiple onChange={(event) => { if (event.target.files) void addMockups(event.target.files); event.target.value = '' }} />
      <input ref={artworkInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { if (event.target.files) addArtworks(event.target.files); event.target.value = '' }} />
    </main>
  )
}

export default MockupStudio
export { renderMockup }
export type { Mockup, Artwork, ExportFormat }
