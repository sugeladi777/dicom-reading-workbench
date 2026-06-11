import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParsedDicomImage } from '../dicom';
import type { ViewerSeries } from '../types';

export type DockZone = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type DockDrop = { targetIndex: number; zone: DockZone };
export type ViewerLayoutKind =
  | 'single'
  | 'two-horizontal'
  | 'three-horizontal'
  | 'three-left-stack'
  | 'three-right-stack'
  | 'three-top-stack'
  | 'three-bottom-stack'
  | 'grid-4';

type ToolMode = 'pan' | 'window' | 'line' | 'angle' | 'rect' | 'ellipse';

type ViewportState = {
  sliceIndex: number;
  zoom: number;
  panX: number;
  panY: number;
  windowCenter: number;
  windowWidth: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
};

type ImagePoint = { x: number; y: number };
type Measurement = { id: string; tool: Exclude<ToolMode, 'pan' | 'window'>; points: ImagePoint[] };

type DragState =
  | { mode: 'pan'; startX: number; startY: number; panX: number; panY: number }
  | { mode: 'window'; startX: number; startY: number; center: number; width: number }
  | { mode: 'measure'; start: ImagePoint };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function defaultViewport(image?: ParsedDicomImage): ViewportState {
  return {
    sliceIndex: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    windowCenter: image?.windowCenter || 40,
    windowWidth: Math.max(1, image?.windowWidth || 400),
    rotation: 0,
    flipH: false,
    flipV: false
  };
}

function imageToCanvas(image: ParsedDicomImage, viewport: ViewportState) {
  const temp = document.createElement('canvas');
  temp.width = image.columns;
  temp.height = image.rows;
  const ctx = temp.getContext('2d');
  if (!ctx) return temp;

  const imageData = ctx.createImageData(image.columns, image.rows);
  const low = viewport.windowCenter - viewport.windowWidth / 2;
  const high = viewport.windowCenter + viewport.windowWidth / 2;
  const inverse = image.photometricInterpretation === 'MONOCHROME1';

  for (let i = 0; i < image.pixels.length; i += 1) {
    let gray = clamp(Math.round(((image.pixels[i] - low) / (high - low)) * 255), 0, 255);
    if (inverse) gray = 255 - gray;
    const offset = i * 4;
    imageData.data[offset] = gray;
    imageData.data[offset + 1] = gray;
    imageData.data[offset + 2] = gray;
    imageData.data[offset + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return temp;
}

function distance(a: ImagePoint, b: ImagePoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleDegrees(a: ImagePoint, b: ImagePoint, c: ImagePoint) {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const mag = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
  if (!mag) return 0;
  return (Math.acos(clamp(dot / mag, -1, 1)) * 180) / Math.PI;
}

function meanPixel(image: ParsedDicomImage, p1: ImagePoint, p2: ImagePoint, ellipse = false) {
  const minX = clamp(Math.floor(Math.min(p1.x, p2.x)), 0, image.columns - 1);
  const maxX = clamp(Math.ceil(Math.max(p1.x, p2.x)), 0, image.columns - 1);
  const minY = clamp(Math.floor(Math.min(p1.y, p2.y)), 0, image.rows - 1);
  const maxY = clamp(Math.ceil(Math.max(p1.y, p2.y)), 0, image.rows - 1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = Math.max(1, (maxX - minX) / 2);
  const ry = Math.max(1, (maxY - minY) / 2);
  let sum = 0;
  let count = 0;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (ellipse && (((x - cx) ** 2) / rx ** 2 + ((y - cy) ** 2) / ry ** 2) > 1) continue;
      sum += image.pixels[y * image.columns + x] || 0;
      count += 1;
    }
  }

  return { count, mean: count ? sum / count : 0 };
}

function areaForIndex(index: number) {
  return ['a', 'b', 'c', 'd'][index] || 'd';
}

function fitImageScale(image: ParsedDicomImage, rect: DOMRect) {
  const availableWidth = Math.max(1, rect.width - 24);
  const availableHeight = Math.max(1, rect.height - 42);
  return Math.max(0.05, Math.min(availableWidth / image.columns, availableHeight / image.rows) * 0.96);
}

function dockZoneFromEvent(event: React.DragEvent<HTMLElement>, element: HTMLElement): DockZone {
  const rect = element.getBoundingClientRect();
  const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
  if (x > 0.34 && x < 0.66 && y > 0.34 && y < 0.66) return 'center';
  return [
    { zone: 'left' as const, distance: x },
    { zone: 'right' as const, distance: 1 - x },
    { zone: 'top' as const, distance: y },
    { zone: 'bottom' as const, distance: 1 - y }
  ].sort((a, b) => a.distance - b.distance)[0].zone;
}

function dropLabel(zone: DockZone) {
  if (zone === 'left') return '在左侧新建分区';
  if (zone === 'right') return '在右侧新建分区';
  if (zone === 'top') return '在上方新建分区';
  if (zone === 'bottom') return '在下方新建分区';
  return '替换当前分区';
}

function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
}

type ViewportCanvasProps = {
  index: number;
  area: string;
  enabled: boolean;
  active: boolean;
  series?: ViewerSeries;
  viewport: ViewportState;
  tool: ToolMode;
  syncScroll: boolean;
  showDicomInfo: boolean;
  measurements: Measurement[];
  dropZone?: DockZone;
  draggingCaseId: string;
  onActivate: (index: number) => void;
  onChange: (index: number, next: ViewportState | ((value: ViewportState) => ViewportState), syncSlice?: boolean) => void;
  onMeasurementAdd: (index: number, measurement: Measurement) => void;
  onClose: (index: number) => void;
  onDragUpdate: (event: React.DragEvent<HTMLDivElement>, index: number) => void;
  onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>, index: number) => void;
};

function ViewportCanvas({
  index,
  area,
  enabled,
  active,
  series,
  viewport,
  tool,
  syncScroll,
  showDicomInfo,
  measurements,
  dropZone,
  draggingCaseId,
  onActivate,
  onChange,
  onMeasurementAdd,
  onClose,
  onDragUpdate,
  onDragLeave,
  onDrop
}: ViewportCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const previewRef = useRef<Measurement | null>(null);
  const images = series?.images || [];
  const image = images[clamp(viewport.sliceIndex, 0, Math.max(0, images.length - 1))];

  const imageToScreen = useCallback(
    (point: ImagePoint, rect: DOMRect) => {
      if (!image) return { x: 0, y: 0 };
      const scale = fitImageScale(image, rect) * viewport.zoom;
      const angle = (viewport.rotation * Math.PI) / 180;
      let x = point.x - image.columns / 2;
      let y = point.y - image.rows / 2;
      if (viewport.flipH) x *= -1;
      if (viewport.flipV) y *= -1;
      const rotatedX = x * Math.cos(angle) - y * Math.sin(angle);
      const rotatedY = x * Math.sin(angle) + y * Math.cos(angle);
      return {
        x: rect.width / 2 + viewport.panX + rotatedX * scale,
        y: rect.height / 2 + viewport.panY + rotatedY * scale
      };
    },
    [image, viewport]
  );

  const screenToImage = useCallback(
    (x: number, y: number, rect: DOMRect) => {
      if (!image) return { x: 0, y: 0 };
      const scale = fitImageScale(image, rect) * viewport.zoom;
      let localX = (x - viewport.panX) / scale;
      let localY = (y - viewport.panY) / scale;
      const angle = (-viewport.rotation * Math.PI) / 180;
      const rotatedX = localX * Math.cos(angle) - localY * Math.sin(angle);
      const rotatedY = localX * Math.sin(angle) + localY * Math.cos(angle);
      localX = viewport.flipH ? -rotatedX : rotatedX;
      localY = viewport.flipV ? -rotatedY : rotatedY;
      return {
        x: clamp(localX + image.columns / 2, 0, image.columns - 1),
        y: clamp(localY + image.rows / 2, 0, image.rows - 1)
      };
    },
    [image, viewport]
  );

  const drawMeasurement = useCallback(
    (ctx: CanvasRenderingContext2D, rect: DOMRect, item: Measurement) => {
      if (!image || item.points.length < 2) return;
      const points = item.points.map((point) => imageToScreen(point, rect));
      ctx.save();
      ctx.strokeStyle = '#7dd3fc';
      ctx.fillStyle = '#dff6ff';
      ctx.lineWidth = 1.5;
      ctx.font = '12px Consolas, Microsoft YaHei, monospace';

      if (item.tool === 'line') {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
        ctx.fillText(`${distance(item.points[0], item.points[1]).toFixed(1)} px`, points[1].x + 6, points[1].y - 6);
      }

      if (item.tool === 'angle' && item.points.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.lineTo(points[2].x, points[2].y);
        ctx.stroke();
        ctx.fillText(`${angleDegrees(item.points[0], item.points[1], item.points[2]).toFixed(1)}°`, points[1].x + 6, points[1].y - 6);
      }

      if (item.tool === 'rect' || item.tool === 'ellipse') {
        const x = Math.min(points[0].x, points[1].x);
        const y = Math.min(points[0].y, points[1].y);
        const width = Math.abs(points[1].x - points[0].x);
        const height = Math.abs(points[1].y - points[0].y);
        if (item.tool === 'rect') ctx.strokeRect(x, y, width, height);
        else {
          ctx.beginPath();
          ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        const stats = meanPixel(image, item.points[0], item.points[1], item.tool === 'ellipse');
        ctx.fillText(`面积 ${stats.count} px  均值 ${stats.mean.toFixed(1)}`, x + 6, y + 16);
      }
      ctx.restore();
    },
    [image, imageToScreen]
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050607';
    ctx.fillRect(0, 0, rect.width, rect.height);

    if (!enabled || !image) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '13px Microsoft YaHei, Arial';
      ctx.fillText(enabled ? '拖拽病例到这里开始分屏阅片' : '点击“开始阅片”后加载图像', 18, 30);
      return;
    }

    const bitmap = imageToCanvas(image, viewport);
    ctx.save();
      const scale = fitImageScale(image, rect) * viewport.zoom;
      ctx.translate(rect.width / 2 + viewport.panX, rect.height / 2 + viewport.panY);
      ctx.rotate((viewport.rotation * Math.PI) / 180);
      ctx.scale((viewport.flipH ? -1 : 1) * scale, (viewport.flipV ? -1 : 1) * scale);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, -image.columns / 2, -image.rows / 2);
    ctx.restore();

    [...measurements, previewRef.current].filter(Boolean).forEach((item) => drawMeasurement(ctx, rect, item as Measurement));

    if (showDicomInfo) {
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.52)';
      ctx.fillRect(10, 36, 288, 94);
      ctx.fillStyle = '#b9d8ff';
      ctx.font = '12px Consolas, Microsoft YaHei, monospace';
      [
        `${series?.label || series?.caseId || ''}`,
        `${image.modality || 'DICOM'} ${image.columns}x${image.rows}`,
        `图像: ${viewport.sliceIndex + 1}/${images.length}`,
        `WC/WW: ${viewport.windowCenter.toFixed(0)} / ${viewport.windowWidth.toFixed(0)}`,
        `缩放: ${(viewport.zoom * 100).toFixed(0)}%  旋转:${viewport.rotation}`
      ].forEach((line, lineIndex) => ctx.fillText(line, 20, 56 + lineIndex * 16));
      ctx.restore();
    }
  }, [drawMeasurement, enabled, image, images.length, measurements, series?.caseId, series?.label, showDicomInfo, viewport]);

  useEffect(() => {
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  const localPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, rect };
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    onActivate(index);
    if (!enabled || !images.length) return;
    const delta = event.deltaY > 0 ? 1 : -1;
    const nextSlice = clamp(viewport.sliceIndex + delta, 0, images.length - 1);
    onChange(index, (value) => ({ ...value, sliceIndex: nextSlice }), syncScroll);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    onActivate(index);
    if (!enabled || !image) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = localPoint(event);

    if (tool === 'window' || event.button === 2) {
      dragRef.current = {
        mode: 'window',
        startX: point.x,
        startY: point.y,
        center: viewport.windowCenter,
        width: viewport.windowWidth
      };
      return;
    }

    if (tool === 'pan') {
      dragRef.current = { mode: 'pan', startX: point.x, startY: point.y, panX: viewport.panX, panY: viewport.panY };
      return;
    }

    const imagePoint = screenToImage(point.x - point.rect.width / 2, point.y - point.rect.height / 2, point.rect);
    dragRef.current = { mode: 'measure', start: imagePoint };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = localPoint(event);

    if (drag.mode === 'pan') {
      onChange(index, (value) => ({ ...value, panX: drag.panX + point.x - drag.startX, panY: drag.panY + point.y - drag.startY }));
      return;
    }

    if (drag.mode === 'window') {
      onChange(index, (value) => ({
        ...value,
        windowWidth: Math.max(1, drag.width + (point.x - drag.startX) * 2),
        windowCenter: drag.center + (point.y - drag.startY) * -1.5
      }));
      return;
    }

    const current = screenToImage(point.x - point.rect.width / 2, point.y - point.rect.height / 2, point.rect);
    const points =
      tool === 'angle'
        ? [drag.start, { x: (drag.start.x + current.x) / 2, y: Math.min(drag.start.y, current.y) - 40 }, current]
        : [drag.start, current];
    previewRef.current = { id: 'preview', tool: tool as Measurement['tool'], points };
    draw();
  };

  const finishPointer = () => {
    const drag = dragRef.current;
    if (drag?.mode === 'measure' && previewRef.current) {
      onMeasurementAdd(index, { ...previewRef.current, id: `${Date.now()}-${Math.random().toString(16).slice(2)}` });
    }
    previewRef.current = null;
    dragRef.current = null;
    draw();
  };

  return (
    <div
      className={`viewport pane-area-${area} ${active ? 'active' : ''} ${dropZone ? 'is-pane-drop-target' : ''}`}
      onDragEnter={(event) => onDragUpdate(event, index)}
      onDragOver={(event) => onDragUpdate(event, index)}
      onDragLeave={onDragLeave}
      onDrop={(event) => onDrop(event, index)}
    >
      {series && (
        <div className="viewport-tab">
          <span>{series.label || series.caseId}</span>
          <button type="button" onClick={() => onClose(index)} aria-label="关闭分区">
            x
          </button>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="dicom-canvas"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onContextMenu={(event) => event.preventDefault()}
      />
      {dropZone && (
        <div className={`unity-drop-overlay dock-${dropZone}`}>
          <div>{draggingCaseId ? `${draggingCaseId} ${dropLabel(dropZone)}` : dropLabel(dropZone)}</div>
        </div>
      )}
    </div>
  );
}

type DicomViewerProps = {
  enabled: boolean;
  allowDrop: boolean;
  series: ViewerSeries[];
  layoutKind: ViewerLayoutKind;
  loading: boolean;
  error: string;
  draggingCaseId: string;
  onDropCase: (caseId: string, drop: DockDrop) => void;
  onCloseSeries: (index: number) => void;
  onActivePaneChange?: (index: number) => void;
};

export function DicomViewer({
  enabled,
  allowDrop,
  series,
  layoutKind,
  loading,
  error,
  draggingCaseId,
  onDropCase,
  onCloseSeries,
  onActivePaneChange
}: DicomViewerProps) {
  const [viewports, setViewports] = useState<ViewportState[]>(() => Array.from({ length: 4 }, () => defaultViewport()));
  const [measurements, setMeasurements] = useState<Record<number, Measurement[]>>({});
  const [dropPreview, setDropPreview] = useState<DockDrop | null>(null);
  const [syncScroll, setSyncScroll] = useState(false);
  const [showDicomInfo, setShowDicomInfo] = useState(true);
  const [tool, setTool] = useState<ToolMode>('pan');
  const [activeIndex, setActiveIndex] = useState(0);
  const paneCount = clamp(series.length || 1, 1, 4);

  useEffect(() => {
    setViewports(Array.from({ length: 4 }, (_unused, index) => defaultViewport(series[index]?.images[0])));
    setMeasurements({});
    setActiveIndex((current) => clamp(current, 0, Math.max(0, series.length - 1)));
  }, [series]);

  useEffect(() => {
    onActivePaneChange?.(activeIndex);
  }, [activeIndex, onActivePaneChange]);

  const activeViewports = useMemo(() => viewports.slice(0, paneCount), [paneCount, viewports]);

  const updateViewport = useCallback(
    (index: number, next: ViewportState | ((value: ViewportState) => ViewportState), syncSlice = false) => {
      setViewports((current) => {
        const base = [...current];
        const nextValue = typeof next === 'function' ? next(base[index]) : next;
        base[index] = nextValue;
        if (!syncSlice) return base;
        return base.map((item, itemIndex) => ({
          ...item,
          sliceIndex: clamp(nextValue.sliceIndex, 0, Math.max(0, (series[itemIndex]?.images.length || 1) - 1))
        }));
      });
    },
    [series]
  );

  const updateDropPreview = useCallback(
    (event: React.DragEvent<HTMLDivElement>, index: number) => {
      event.preventDefault();
      event.stopPropagation();
      if (!allowDrop) return;
      event.dataTransfer.dropEffect = 'copy';
      setDropPreview({ targetIndex: index, zone: dockZoneFromEvent(event, event.currentTarget) });
    },
    [allowDrop]
  );

  const handleDropLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPreview(null);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>, index: number) => {
      event.preventDefault();
      event.stopPropagation();
      if (!allowDrop) {
        setDropPreview(null);
        return;
      }
      const caseId =
        event.dataTransfer.getData('application/x-workbench-case') || event.dataTransfer.getData('text/plain');
      const zone = dropPreview?.targetIndex === index ? dropPreview.zone : dockZoneFromEvent(event, event.currentTarget);
      setDropPreview(null);
      if (caseId) onDropCase(caseId, { targetIndex: index, zone });
    },
    [allowDrop, dropPreview, onDropCase]
  );

  const applyTransform = (change: Partial<ViewportState>) => {
    setViewports((current) => current.map((viewport, index) => (index === activeIndex ? { ...viewport, ...change } : viewport)));
  };

  const rotateActive = useCallback(
    (degrees: number) => {
      setViewports((current) =>
        current.map((viewport, index) => (index === activeIndex ? { ...viewport, rotation: (viewport.rotation + degrees) % 360 } : viewport))
      );
    },
    [activeIndex]
  );

  const clearMeasurements = () => {
    setMeasurements((current) => ({ ...current, [activeIndex]: [] }));
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();

      if (key === 'p') setTool('pan');
      if (key === 'w') setTool('window');
      if (key === 'l') setTool('line');
      if (key === 'a') setTool('angle');
      if (key === 'b') setTool('rect');
      if (key === 'c') setTool('ellipse');
      if (key === 'x') clearMeasurements();
      if (key === 's') setSyncScroll((value) => !value);
      if (key === 'i') setShowDicomInfo((value) => !value);
      if (key === 'h') applyTransform({ flipH: !viewports[activeIndex]?.flipH });
      if (key === 'v') applyTransform({ flipV: !viewports[activeIndex]?.flipV });
      if (event.key === '[') rotateActive(270);
      if (event.key === ']') rotateActive(90);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, rotateActive, viewports]);

  return (
    <section className="viewer-shell minimal">
      <div
        className={`viewer-grid layout-${layoutKind} ${dropPreview ? 'is-drop-target' : ''}`}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPreview(null);
        }}
      >
        {activeViewports.map((viewport, index) => (
          <ViewportCanvas
            key={`${series[index]?.id || 'empty'}-${index}`}
            index={index}
            area={areaForIndex(index)}
            enabled={enabled}
            active={index === activeIndex}
            series={series[index]}
            viewport={viewport}
            tool={tool}
            syncScroll={syncScroll}
            showDicomInfo={showDicomInfo}
            measurements={measurements[index] || []}
            dropZone={dropPreview?.targetIndex === index ? dropPreview.zone : undefined}
            draggingCaseId={draggingCaseId}
            onActivate={setActiveIndex}
            onChange={updateViewport}
            onMeasurementAdd={(itemIndex, measurement) =>
              setMeasurements((current) => ({
                ...current,
                [itemIndex]: [...(current[itemIndex] || []), measurement]
              }))
            }
            onClose={onCloseSeries}
            onDragUpdate={updateDropPreview}
            onDragLeave={handleDropLeave}
            onDrop={handleDrop}
          />
        ))}
        {dropPreview && <div className="viewer-drop-label">{dropLabel(dropPreview.zone)}</div>}
        {loading && <div className="viewer-status">正在加载...</div>}
        {error && <div className="viewer-error">{error}</div>}
      </div>

      <div className="viewer-toolbar">
        <div className="toolbar-group">
          <button type="button" className={syncScroll ? 'active' : ''} title="同步翻页 (S)" onClick={() => setSyncScroll((value) => !value)}>
            同步
          </button>
          <button type="button" className={showDicomInfo ? 'active' : ''} title="显示或隐藏 DICOM 信息 (I)" onClick={() => setShowDicomInfo((value) => !value)}>
            信息
          </button>
        </div>
        <div className="toolbar-group">
          <button type="button" className={tool === 'pan' ? 'active' : ''} title="平移图像 (P)" onClick={() => setTool('pan')}>
            平移
          </button>
          <button type="button" className={tool === 'window' ? 'active' : ''} title="窗宽窗位 (W)" onClick={() => setTool('window')}>
            窗宽窗位
          </button>
          <select value={tool} title="测量工具：直线(L)、角度(A)、矩形(B)、椭圆(C)" onChange={(event) => setTool(event.target.value as ToolMode)}>
            <option value="pan">不测量</option>
            <option value="line">直线</option>
            <option value="angle">角度</option>
            <option value="rect">矩形</option>
            <option value="ellipse">椭圆</option>
          </select>
          <button type="button" title="清除当前分区测量 (X)" onClick={clearMeasurements}>
            清除
          </button>
        </div>
        <div className="toolbar-group">
          <button type="button" title="水平翻转 (H)" onClick={() => applyTransform({ flipH: !viewports[activeIndex]?.flipH })}>
            水平翻转
          </button>
          <button type="button" title="垂直翻转 (V)" onClick={() => applyTransform({ flipV: !viewports[activeIndex]?.flipV })}>
            垂直翻转
          </button>
          <button type="button" className="icon-button" title="左转 90 度 ([)" aria-label="左转 90 度" onClick={() => rotateActive(270)}>
            左转
          </button>
          <button type="button" className="icon-button" title="右转 90 度 (])" aria-label="右转 90 度" onClick={() => rotateActive(90)}>
            右转
          </button>
        </div>
      </div>
    </section>
  );
}
