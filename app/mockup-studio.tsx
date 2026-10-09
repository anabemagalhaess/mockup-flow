'use client'

import { useMemo, useRef, useState } from 'react'
import { readPsd, getLayerCanvas, type Layer, type Psd } from 'ag-psd'
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
  psd: Psd
  layers: PsdLayer[]
  targetId: string
  previewUrl: string
  width: number
  height: number
}
type Artwork = { id: string; file: File; previewUrl: string }
type ExportFormat = 'png' | 'jpg'

const layerKeywords = /clip|mask|design|artwork|art\b|print|placeholder|insert/i
const layerIds = new WeakMap<Layer, string>()

function layerId(layer: Layer) {
  return layerIds.get(layer) || ''
}

function flattenLayers(layers: Layer[] = [], result: PsdLayer[] = []) {
  for (const layer of layers) {
    layerIds.set(layer, `${layer.name || 'layer'}-${result.length}-${layer.left || 0}-${layer.top || 0}`)
    result.push(layer)
    if (layer.children?.length) flattenLayers(layer.children, result)
  }
  return result
}

function findTarget(layers: PsdLayer[]) {
  const namedLayer = layers.find((layer) => layerKeywords.test(layer.name || ''))
  const clippedLayer = layers.find((layer) => layer.clipping)
  const imageLayer = layers.find((layer) => layer.canvas || layer.imageData)
  return layerId(namedLayer || clippedLayer || imageLayer || layers[0])
}

function toCanvas(layer: Layer) {
  return getLayerCanvas(layer)
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

async function renderMockup(mockup: Mockup, artwork: Artwork, targetId: string, format: ExportFormat) {
  const target = mockup.layers.find((layer) => layerId(layer) === targetId)
  const targetCanvas = target ? toCanvas(target) : undefined
  if (!target || !targetCanvas) throw new Error(`A camada selecionada não tem imagem rasterizada: ${target?.name || 'camada'}`)

  const output = document.createElement('canvas')
  output.width = mockup.width
  output.height = mockup.height
  const context = output.getContext('2d')
  if (!context) throw new Error('Este browser não suporta composição em canvas.')

  if (format === 'jpg') {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, output.width, output.height)
  }

  for (const layer of [...mockup.layers].reverse()) {
    if (layerId(layer) === targetId || layer.hidden) continue
    const canvas = toCanvas(layer)
    if (!canvas) continue
    context.drawImage(canvas, layer.left || 0, layer.top || 0)
  }

  const artworkBitmap = await createImageBitmap(artwork.file)
  const artLayer = document.createElement('canvas')
  artLayer.width = targetCanvas.width
  artLayer.height = targetCanvas.height
  const artContext = artLayer.getContext('2d')
  if (!artContext) throw new Error('Não foi possível preparar a ilustração.')
  fitImage(artContext, artworkBitmap, artworkBitmap.width, artworkBitmap.height, 0, 0, artLayer.width, artLayer.height)
  artContext.globalCompositeOperation = 'destination-in'
  artContext.drawImage(targetCanvas, 0, 0)
  artworkBitmap.close()

  context.drawImage(artLayer, target.left || 0, target.top || 0)
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

function PreviewStage({ mockup, artwork, targetId }: { mockup?: Mockup; artwork?: Artwork; targetId?: string }) {
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
  const selectedLayer = mockup.layers.find((layer) => layerId(layer) === targetId)
  const selectedMask = selectedLayer ? toCanvas(selectedLayer) : undefined
  const maskImage = selectedMask ? `url("${selectedMask.toDataURL('image/png')}")` : undefined
  return (
    <div className="preview-active">
      <div className="preview-image-wrap">
        <img src={mockup.previewUrl} alt={`Pré-visualização de ${mockup.file.name}`} />
        {artwork && selectedLayer && (
          <div className="preview-artwork-overlay" style={{
            left: `${((selectedLayer.left || 0) / mockup.width) * 100}%`,
            top: `${((selectedLayer.top || 0) / mockup.height) * 100}%`,
            width: `${((selectedMask?.width || (selectedLayer.right || 0) - (selectedLayer.left || 0)) / mockup.width) * 100}%`,
            height: `${((selectedMask?.height || (selectedLayer.bottom || 0) - (selectedLayer.top || 0)) / mockup.height) * 100}%`,
            maskImage,
            WebkitMaskImage: maskImage,
            maskSize: '100% 100%',
            WebkitMaskSize: '100% 100%',
          }}>
            <img src={artwork.previewUrl} alt="Ilustração selecionada" />
          </div>
        )}
      </div>
      <div className="preview-caption"><span><strong>{mockup.file.name}</strong><small>{mockup.width} × {mockup.height} px</small></span><span className="preview-ready"><Check size={13} /> {artwork ? 'Pré-visualização' : 'Mockup carregado'}</span></div>
    </div>
  )
}

export default function MockupStudio() {
  const [mockups, setMockups] = useState<Mockup[]>([])
  const [artworks, setArtworks] = useState<Artwork[]>([])
  const [selectedMockupId, setSelectedMockupId] = useState<string>()
  const [selectedArtworkId, setSelectedArtworkId] = useState<string>()
  const [format, setFormat] = useState<ExportFormat>('png')
  const [automatic, setAutomatic] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const selectedMockup = mockups.find((item) => item.id === selectedMockupId) || mockups[0]
  const selectedArtwork = artworks.find((item) => item.id === selectedArtworkId) || artworks[0]
  const readyCount = mockups.filter((item) => item.layers.some((layer) => layerId(layer) === item.targetId)).length
  const exportCount = mockups.length * artworks.length
  const targetLayer = selectedMockup?.layers.find((layer) => layerId(layer) === selectedMockup.targetId)
  const artworkLabel = useMemo(() => artworks.length === 1 ? '1 ilustração' : `${artworks.length} ilustrações`, [artworks.length])

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
        const psd = readPsd(await file.arrayBuffer())
        const layers = flattenLayers(psd.children || []).filter((layer) => !layer.children?.length)
        if (!layers.length) throw new Error('Este PSD não contém camadas com imagem.')
        const width = psd.width
        const height = psd.height
        const composite = document.createElement('canvas')
        composite.width = width
        composite.height = height
        const context = composite.getContext('2d')
        if (!context) throw new Error('Não foi possível criar a pré-visualização.')
        for (const layer of [...layers].reverse()) {
          const canvas = toCanvas(layer)
          if (canvas && !layer.hidden) context.drawImage(canvas, layer.left || 0, layer.top || 0)
        }
        const previewUrl = composite.toDataURL('image/png')
        const targetId = automatic ? findTarget(layers) : (layers[0] ? layerId(layers[0]) : '')
        next.push({ id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`, file, psd, layers, targetId, previewUrl, width, height })
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
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 4 } })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `mockup-studio-${format}.zip`
      anchor.click()
      URL.revokeObjectURL(url)
      setMessage(`${exportCount} ficheiros exportados em ${format.toUpperCase()}.`)
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
          <div className="sidebar-section-heading"><span>ESPAÇO DE TRABALHO</span><button type="button" className="icon-button" aria-label="Adicionar mockup" onClick={() => document.querySelector<HTMLInputElement>('.sidebar-upload input')?.click()}><Plus size={16} /></button></div>
          <div className="sidebar-nav-item active"><FolderOpen size={17} /><span>Os meus mockups</span><span className="nav-count">{mockups.length}</span></div>
          <div className="sidebar-list-label">COLEÇÃO <span>{mockups.length.toString().padStart(2, '0')}</span></div>
          {mockups.length ? <div className="mockup-list">{mockups.map((mockup) => (
            <button className={`mockup-list-item${selectedMockup?.id === mockup.id ? ' selected' : ''}`} key={mockup.id} onClick={() => setSelectedMockupId(mockup.id)} type="button">
              <span className="list-thumb"><img src={mockup.previewUrl} alt="" /></span>
              <span className="list-file-info"><strong>{mockup.file.name.replace(/\.psd$/i, '')}</strong><small>{mockup.width} × {mockup.height}</small></span>
              <span className="list-dot" />
            </button>
          ))}</div> : <div className="sidebar-empty">Os teus mockups PSD vão aparecer aqui.</div>}
          <div className="sidebar-upload" id="mockup-upload-trigger">
            <Dropzone title="Adicionar mockups" subtitle="Arrasta ficheiros .psd ou procura" accept=".psd,image/vnd.adobe.photoshop" multiple onFiles={addMockupFiles} compact />
          </div>
          <div className="sidebar-footer"><span className="privacy-icon"><Check size={13} /></span><span><strong>Privado por natureza</strong><small>Os ficheiros não saem do teu dispositivo.</small></span></div>
        </aside>

        <section className="main-panel" id="inicio">
          <div className="page-heading">
            <div><div className="eyebrow"><span>WORKSPACE</span><span className="eyebrow-slash">/</span><span>MOCKUP STUDIO</span></div><h1>Mockup studio<span>.</span></h1><p>As tuas ilustrações, no lugar certo.</p></div>
            <div className="page-actions"><span className="collection-status"><span />{mockups.length ? `${mockups.length} mockup${mockups.length === 1 ? '' : 's'} na coleção` : 'A tua coleção está pronta'}</span><button type="button" className="button button-secondary" onClick={() => document.querySelector<HTMLInputElement>('.sidebar-upload input')?.click()}><Plus size={16} /> Adicionar PSD</button></div>
          </div>

          <div className="stepper" aria-label="Etapas de trabalho">
            <div className={`step-item${mockups.length ? ' step-complete' : ' step-current'}`}><span className="step-number">{mockups.length ? <Check size={13} /> : '01'}</span><span>Mockups</span></div><span className="step-line" />
            <div className={`step-item${artworks.length ? ' step-complete' : mockups.length ? ' step-current' : ''}`}><span className="step-number">{artworks.length ? <Check size={13} /> : '02'}</span><span>Ilustrações</span></div><span className="step-line" />
            <div className={`step-item${mockups.length && artworks.length ? ' step-current' : ''}`}><span className="step-number">03</span><span>Exportar</span></div>
          </div>

          <div className="work-area">
            <div className="preview-column">
              <div className="section-heading"><div><span className="section-kicker">01 — PRÉ-VISUALIZAÇÃO</span><h2>Vista geral</h2></div><button className="view-control" type="button" aria-label="Pré-visualização do mockup"><ScanLine size={16} /><span>Enquadrar</span></button></div>
              <div className="preview-card"><PreviewStage mockup={selectedMockup} artwork={selectedArtwork} targetId={selectedMockup?.targetId} /></div>
              {message && <div className={`status-message${message.includes('exportados') ? ' success-message' : ''}`} role="status">{message}</div>}
              <div className="collection-strip"><div className="strip-heading"><div><span className="section-kicker">A TUA COLEÇÃO</span><h3>Mockups <span>{mockups.length.toString().padStart(2, '0')}</span></h3></div><button type="button" className="text-button" onClick={() => document.querySelector<HTMLInputElement>('.sidebar-upload input')?.click()}>Ver todos <ChevronDown size={14} /></button></div>
                {mockups.length ? <div className="collection-grid">{mockups.map((mockup) => <div key={mockup.id} className={`collection-card${selectedMockup?.id === mockup.id ? ' collection-card-active' : ''}`} role="button" tabIndex={0} onClick={() => setSelectedMockupId(mockup.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedMockupId(mockup.id) }}><span className="collection-thumb"><img src={mockup.previewUrl} alt="" /><span className="file-type">PSD</span><button type="button" className="remove-item" aria-label={`Remover ${mockup.file.name}`} onClick={(event) => { event.stopPropagation(); removeMockup(mockup.id) }} onKeyDown={(event) => event.stopPropagation()}><X size={13} /></button></span><span className="collection-name">{mockup.file.name.replace(/\.psd$/i, '')}</span><span className="collection-meta">{mockup.width} × {mockup.height} px</span></div>)}<Dropzone title="Adicionar" subtitle="" accept=".psd,image/vnd.adobe.photoshop" multiple onFiles={addMockupFiles} compact /></div> : <div className="collection-empty"><div className="collection-empty-icon"><FileImage size={18} /></div><span><strong>Ainda sem mockups</strong><small>Adiciona um ficheiro PSD para começar a coleção.</small></span><button type="button" onClick={() => document.querySelector<HTMLInputElement>('.sidebar-upload input')?.click()}>Escolher ficheiros <Plus size={14} /></button></div>}
              </div>
            </div>

            <aside className="settings-column">
              <div className="section-heading settings-heading"><div><span className="section-kicker">02 — PREPARAR</span><h2>Configuração</h2></div><span className="settings-status"><span /> Pronto</span></div>
              <div className="settings-card">
                <div className="setting-block"><div className="setting-title-row"><div><span className="setting-index">A</span><div><h3>Camada de destino</h3><p>Onde inserir a ilustração</p></div></div></div>
                  {selectedMockup ? <label className="select-wrap"><span className="sr-only">Selecionar camada de destino</span><select value={selectedMockup.targetId} onChange={(event) => chooseTarget(selectedMockup.id, event.target.value)}>{selectedMockup.layers.map((layer) => <option key={layerId(layer)} value={layerId(layer)}>{layer.name || 'Camada sem nome'}</option>)}</select><ChevronDown size={15} /></label> : <div className="setting-placeholder">Adiciona um PSD para escolher a camada.</div>}
                  <button type="button" className={`auto-detect${automatic ? ' auto-active' : ''}`} onClick={toggleAutomatic}><span className="auto-icon"><Sparkles size={14} /></span><span><strong>Deteção automática</strong><small>{automatic ? 'Ativa · procura “mask”, “art” e “design”' : 'Desativada · seleção manual'}</small></span><span className="switch-track"><i /></span></button>
                  {selectedMockup && <div className="layer-info"><Layers2 size={14} /><span>{targetLayer?.name || 'Camada selecionada'}</span><span>{targetLayer?.canvas?.width || Math.max(0, (targetLayer?.right || 0) - (targetLayer?.left || 0))} × {targetLayer?.canvas?.height || Math.max(0, (targetLayer?.bottom || 0) - (targetLayer?.top || 0))} px</span></div>}
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
              <div className="privacy-note"><span><Check size={14} /></span><p><strong>As tuas imagens ficam contigo.</strong> Todo o processamento acontece localmente no teu dispositivo.</p></div>
            </aside>
          </div>
          <footer className="workspace-footer"><span>atelier<span className="footer-dot">.</span> <span className="footer-version">MOCKUP STUDIO</span></span><span>{mockups.length} PSD <i /> {artworks.length} imagens prontas</span></footer>
        </section>
      </div>
      {busy && <div className="loading-overlay" aria-live="polite"><LoaderCircle className="spin" size={22} /><span>A processar ficheiros no browser…</span></div>}
    </main>
  )
}

export { Dropzone }

