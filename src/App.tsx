import { useEffect, useMemo, useRef, useState } from 'react';
import { Database, Eye, Filter, Play, Save, Search, Send } from 'lucide-react';
import { DicomViewer, type DockDrop, type ViewerLayoutKind } from './components/DicomViewer';
import { parseDicomSeries } from './dicom';
import type {
  ActiveDraftPayload,
  CaseDetail,
  ImportDataResult,
  ReportQuality,
  SaveSessionPayload,
  ViewerSeries,
  WorkbenchCase
} from './types';

const DESCRIPTION_TEMPLATE = '【影像所见】\n';
const DIAGNOSIS_TEMPLATE = '【诊断意见】\n';
const CONFIDENCE_OPTIONS = ['非常有把握', '比较有把握', '一般', '把握较低', '没有把握'];
const REASONING_PURPOSE_OPTIONS = ['缺少诊断信心', '缺少诊断知识', '质疑参考报告内容', '确认诊断依据', '对推理内容好奇'];
const REASONING_GOAL_OPTIONS = ['完全实现', '基本实现', '部分实现', '未实现'];

const REPORT_QUALITY_LABELS: Record<keyof ReportQuality, string> = {
  structure: '结构完整性',
  localization: '病灶定位',
  feature: '特征描述',
  accuracy: '诊断准确性',
  usability: '整体可用性'
};

type ModalMode = 'reasoning' | 'submit' | null;
type ReasoningDragState = { startX: number; startY: number; right: number; bottom: number } | null;

function normalizedLayout(count: number): ViewerLayoutKind {
  if (count <= 1) return 'single';
  if (count === 2) return 'two-horizontal';
  if (count === 3) return 'three-horizontal';
  return 'grid-4';
}

function layoutForThreePanes(drop: DockDrop): ViewerLayoutKind {
  if (drop.zone === 'left') return 'three-left-stack';
  if (drop.zone === 'right') return 'three-right-stack';
  if (drop.zone === 'top') return 'three-top-stack';
  if (drop.zone === 'bottom') return 'three-bottom-stack';
  return 'three-horizontal';
}

function insertAt<T>(items: T[], index: number, item: T) {
  const next = [...items];
  next.splice(index, 0, item);
  return next;
}

function emptyReportQuality(): ReportQuality {
  return { structure: 0, localization: 0, feature: 0, accuracy: 0, usability: 0 };
}

function withTemplate(template: string, value: string) {
  const trimmed = value.trim();
  return trimmed ? `${template}${trimmed}` : template;
}

function hasCompleteReportQuality(value: ReportQuality) {
  return Object.values(value).every((item) => item > 0);
}

function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function isFormInput(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
}

function StarRating({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <div className="star-rating" role="radiogroup">
      {[1, 2, 3, 4, 5].map((score) => (
        <button
          key={score}
          type="button"
          className={score <= value ? 'active' : ''}
          aria-label={`${score} 分`}
          aria-checked={value === score}
          role="radio"
          title={`${score} 分`}
          onClick={() => onChange(score)}
        >
          ★
        </button>
      ))}
      <span>{value || '未评分'}</span>
    </div>
  );
}

export function App() {
  const [cases, setCases] = useState<WorkbenchCase[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState('');
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [viewerSeries, setViewerSeries] = useState<ViewerSeries[]>([]);
  const [viewerLayout, setViewerLayout] = useState<ViewerLayoutKind>('single');
  const [focusedViewerIndex, setFocusedViewerIndex] = useState(0);
  const [readerId, setReaderId] = useState('reader-001');
  const [description, setDescription] = useState(DESCRIPTION_TEMPLATE);
  const [diagnosis, setDiagnosis] = useState(DIAGNOSIS_TEMPLATE);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [writingStartedAt, setWritingStartedAt] = useState<string | null>(null);
  const [reasoningRequestedAt, setReasoningRequestedAt] = useState('');
  const [reasoningShownAt, setReasoningShownAt] = useState('');
  const [submitOpenedAt, setSubmitOpenedAt] = useState<string | null>(null);
  const [taskElapsedMs, setTaskElapsedMs] = useState(0);
  const [totalElapsedMs, setTotalElapsedMs] = useState(0);
  const [taskRunning, setTaskRunning] = useState(false);
  const [totalRunning, setTotalRunning] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [viewedReasoning, setViewedReasoning] = useState(false);
  const [reasoningPanelOpen, setReasoningPanelOpen] = useState(false);
  const [savedBeforeReasoning, setSavedBeforeReasoning] = useState('');
  const [reasoningConfidence, setReasoningConfidence] = useState('');
  const [reasoningPurposes, setReasoningPurposes] = useState<string[]>([]);
  const [reasoningGoalAchieved, setReasoningGoalAchieved] = useState('');
  const [finalConfidence, setFinalConfidence] = useState('');
  const [reportQuality, setReportQuality] = useState<ReportQuality>(() => emptyReportQuality());
  const [loadingCases, setLoadingCases] = useState(false);
  const [loadingImages, setLoadingImages] = useState(false);
  const [viewerError, setViewerError] = useState('');
  const [status, setStatus] = useState('');
  const [lastSessionId, setLastSessionId] = useState<number | null>(null);
  const [draggingCaseId, setDraggingCaseId] = useState('');
  const [exportingData, setExportingData] = useState(false);
  const [caseSearch, setCaseSearch] = useState('');
  const [modalityFilter, setModalityFilter] = useState<'all' | 'CT' | 'MRI' | 'DICOM'>('all');
  const [completedCaseIds, setCompletedCaseIds] = useState<string[]>([]);
  const [draftCaseIds, setDraftCaseIds] = useState<string[]>([]);
  const [showOnlyPending, setShowOnlyPending] = useState(false);
  const [reasoningPanelPosition, setReasoningPanelPosition] = useState({ right: 22, bottom: 22 });
  const [reasoningDragging, setReasoningDragging] = useState<ReasoningDragState>(null);
  const [restoringDraft, setRestoringDraft] = useState(false);

  const active = Boolean(startedAt);
  const lastTick = useRef(Date.now());

  const currentCaseSummary = useMemo(() => cases.find((item) => item.caseId === selectedCaseId) || null, [cases, selectedCaseId]);
  const completedCount = completedCaseIds.length;
  const draftCount = draftCaseIds.length;
  const pendingCount = Math.max(0, cases.length - completedCount);
  const completionPercent = cases.length ? Math.round((completedCount / cases.length) * 100) : 0;
  const currentCaseCompleted = selectedCaseId ? completedCaseIds.includes(selectedCaseId) : false;
  const currentCaseHasDraft = selectedCaseId ? draftCaseIds.includes(selectedCaseId) : false;
  const findingsLength = description.replace(DESCRIPTION_TEMPLATE, '').trim().length;
  const diagnosisLength = diagnosis.replace(DIAGNOSIS_TEMPLATE, '').trim().length;
  const reasoningText = caseDetail?.reasoning?.trim() || '当前病例 JSON 中未提供推理内容。';
  const reportQualityCompleted = hasCompleteReportQuality(reportQuality);

  const filteredCases = useMemo(() => {
    const keyword = caseSearch.trim().toLowerCase();
    return cases
      .filter((item) => {
        const matchKeyword =
          !keyword ||
          item.caseId.toLowerCase().includes(keyword) ||
          item.modality.toLowerCase().includes(keyword) ||
          (item.patientId || '').toLowerCase().includes(keyword);
        const matchModality = modalityFilter === 'all' || item.modality === modalityFilter;
        const matchPending = !showOnlyPending || !completedCaseIds.includes(item.caseId);
        return matchKeyword && matchModality && matchPending;
      })
      .sort((a, b) => {
        const aCompleted = completedCaseIds.includes(a.caseId);
        const bCompleted = completedCaseIds.includes(b.caseId);
        if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;
        return a.caseId.localeCompare(b.caseId, 'zh-CN', { numeric: true });
      });
  }, [caseSearch, cases, completedCaseIds, modalityFilter, showOnlyPending]);

  useEffect(() => {
    void refreshCases();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const delta = now - lastTick.current;
      lastTick.current = now;
      if (taskRunning) setTaskElapsedMs((value) => value + delta);
      if (totalRunning) setTotalElapsedMs((value) => value + delta);
    }, 250);
    return () => window.clearInterval(timer);
  }, [taskRunning, totalRunning]);

  useEffect(() => {
    const stopImported = window.workbench.onDataImported((result) => applyImportedData(result));
    const stopImportError = window.workbench.onDataImportError((message) => setStatus(message));
    const stopMenuAction = window.workbench.onMenuAction((action) => {
      if (action === 'refresh-cases') void refreshCases();
      if (action === 'restore-report-template') restoreReportTemplate();
      if (action === 'clear-report') clearReport();
      if (action === 'export-csv') void exportSessions('csv');
      if (action === 'export-json') void exportSessions('json');
    });
    return () => {
      stopImported();
      stopImportError();
      stopMenuAction();
    };
  }, [active]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isFormInput(event.target) || modalMode || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'Space' && selectedCaseId && !active) {
        event.preventDefault();
        void startReading();
        return;
      }
      if (event.key.toLowerCase() === 't' && active) {
        event.preventDefault();
        openSubmitSurvey();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, modalMode, selectedCaseId]);

  useEffect(() => {
    if (!reasoningDragging) return;
    const handlePointerMove = (event: PointerEvent) => {
      const deltaX = event.clientX - reasoningDragging.startX;
      const deltaY = event.clientY - reasoningDragging.startY;
      setReasoningPanelPosition({
        right: Math.max(12, reasoningDragging.right - deltaX),
        bottom: Math.max(12, reasoningDragging.bottom - deltaY)
      });
    };
    const handlePointerUp = () => setReasoningDragging(null);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [reasoningDragging]);

  useEffect(() => {
    if (selectedCaseId) void loadCaseDetail(selectedCaseId);
  }, [selectedCaseId]);

  useEffect(() => {
    if (!active || restoringDraft || currentCaseCompleted) return;
    const draft = createDraftPayload();
    if (!draft) return;
    const timer = window.setTimeout(() => {
      void window.workbench
        .saveDraft(draft)
        .then(() => {
          setDraftCaseIds((current) => (current.includes(draft.caseId) ? current : [...current, draft.caseId]));
        })
        .catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [
    active,
    restoringDraft,
    currentCaseCompleted,
    readerId,
    selectedCaseId,
    currentCaseSummary,
    startedAt,
    writingStartedAt,
    reasoningRequestedAt,
    reasoningShownAt,
    submitOpenedAt,
    taskElapsedMs,
    totalElapsedMs,
    taskRunning,
    totalRunning,
    viewedReasoning,
    description,
    diagnosis,
    savedBeforeReasoning,
    reasoningConfidence,
    reasoningPurposes,
    reasoningGoalAchieved,
    finalConfidence,
    reportQuality,
    viewerSeries,
    viewerLayout,
    focusedViewerIndex
  ]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      const draft = createDraftPayload();
      if (draft) void window.workbench.saveDraft(draft).catch(() => undefined);
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  });

  async function refreshCases() {
    setLoadingCases(true);
    try {
      const scannedCases = await window.workbench.scanCases();
      const sessions = await window.workbench.listSessions();
      const drafts = await window.workbench.listDrafts();
      const completedIds = [...new Set(sessions.map((item) => String(item.case_id || '')).filter(Boolean))];
      const draftIds = [...new Set(drafts.map((item) => String(item.caseId || '')).filter(Boolean))];
      setCases(scannedCases);
      setCompletedCaseIds(completedIds.filter((caseId) => scannedCases.some((item) => item.caseId === caseId)));
      setDraftCaseIds(draftIds.filter((caseId) => scannedCases.some((item) => item.caseId === caseId) && !completedIds.includes(caseId)));
      setStatus(`已加载 ${scannedCases.length} 个病例。`);
      if (!selectedCaseId && scannedCases.length) setSelectedCaseId(scannedCases[0].caseId);
      if (selectedCaseId && !scannedCases.some((item) => item.caseId === selectedCaseId)) {
        setSelectedCaseId(scannedCases[0]?.caseId || '');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '病例扫描失败。');
    } finally {
      setLoadingCases(false);
    }
  }

  function resetSessionState() {
    setDescription(DESCRIPTION_TEMPLATE);
    setDiagnosis(DIAGNOSIS_TEMPLATE);
    setStartedAt(null);
    setWritingStartedAt(null);
    setReasoningRequestedAt('');
    setReasoningShownAt('');
    setSubmitOpenedAt(null);
    setTaskElapsedMs(0);
    setTotalElapsedMs(0);
    setTaskRunning(false);
    setTotalRunning(false);
    setModalMode(null);
    setViewedReasoning(false);
    setReasoningPanelOpen(false);
    setSavedBeforeReasoning('');
    setReasoningConfidence('');
    setReasoningPurposes([]);
    setReasoningGoalAchieved('');
    setFinalConfidence('');
    setReportQuality(emptyReportQuality());
    setLastSessionId(null);
    setViewerError('');
    setViewerSeries([]);
    setViewerLayout('single');
    setFocusedViewerIndex(0);
  }

  async function loadCaseDetail(caseId: string) {
    setSelectedCaseId(caseId);
    setViewerError('');
    try {
      const detail = await window.workbench.getCase(caseId);
      setCaseDetail(detail);
      setDescription(withTemplate(DESCRIPTION_TEMPLATE, detail.aiDescription || ''));
      setDiagnosis(withTemplate(DIAGNOSIS_TEMPLATE, detail.aiDiagnosis || ''));
    } catch (error) {
      setCaseDetail(null);
      setStatus(error instanceof Error ? error.message : '病例加载失败。');
    }
  }

  async function buildSeries(caseId: string): Promise<ViewerSeries | null> {
    const summary = cases.find((item) => item.caseId === caseId);
    if (!summary) return null;
    const detail = caseDetail?.caseId === caseId ? caseDetail : await window.workbench.getCase(caseId);
    if (caseDetail?.caseId !== caseId) setCaseDetail(detail);
    const payloads = await window.workbench.readDicomFiles(detail.dicomFiles);
    return {
      id: `${caseId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      caseId,
      label: `${caseId}${summary.modality ? ` · ${summary.modality}` : ''}`,
      images: parseDicomSeries(payloads)
    };
  }

  async function loadViewerSeriesBundle(caseIds: string[], layoutKind?: ViewerLayoutKind | string, focusIndex = 0) {
    const uniqueCaseIds = [...new Set(caseIds.filter(Boolean))].slice(0, 4);
    if (!uniqueCaseIds.length) {
      setViewerSeries([]);
      setViewerLayout('single');
      setFocusedViewerIndex(0);
      return;
    }
    setLoadingImages(true);
    setViewerError('');
    try {
      const bundles = await Promise.all(uniqueCaseIds.map((caseId) => buildSeries(caseId)));
      const nextSeries = bundles.filter(Boolean) as ViewerSeries[];
      setViewerSeries(nextSeries);
      const normalized = normalizedLayout(nextSeries.length);
      const nextLayout = typeof layoutKind === 'string' && layoutKind ? (layoutKind as ViewerLayoutKind) : normalized;
      setViewerLayout(nextSeries.length === 3 || nextSeries.length === 4 ? nextLayout : normalized);
      setFocusedViewerIndex(Math.max(0, Math.min(focusIndex, Math.max(0, nextSeries.length - 1))));
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : '影像加载失败。');
    } finally {
      setLoadingImages(false);
    }
  }

  async function loadSeriesIntoViewer(caseId: string, replaceIndex?: number) {
    setLoadingImages(true);
    setViewerError('');
    try {
      const nextSeries = await buildSeries(caseId);
      if (!nextSeries) return;
      setViewerSeries((current) => {
        if (typeof replaceIndex === 'number') {
          const cloned = [...current];
          cloned[replaceIndex] = nextSeries;
          return cloned;
        }
        return [nextSeries];
      });
      setViewerLayout((current) => (typeof replaceIndex === 'number' ? current : normalizedLayout(1)));
      setFocusedViewerIndex(typeof replaceIndex === 'number' ? replaceIndex : 0);
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : 'DICOM 图像加载失败。');
    } finally {
      setLoadingImages(false);
    }
  }

  function createDraftPayload(): ActiveDraftPayload | null {
    if (!active || !selectedCaseId || !currentCaseSummary || !startedAt || !writingStartedAt) return null;
    return {
      readerId,
      caseId: selectedCaseId,
      modality: currentCaseSummary.modality,
      patientId: currentCaseSummary.patientId,
      startedAt,
      writingStartedAt,
      reasoningRequestedAt,
      reasoningShownAt,
      submitOpenedAt: submitOpenedAt || '',
      taskElapsedMs,
      totalElapsedMs,
      taskRunning,
      totalRunning,
      viewedReasoning,
      description,
      diagnosis,
      savedBeforeReasoning,
      reasoningConfidence,
      reasoningPurposes,
      reasoningGoalAchieved,
      finalConfidence,
      reportQuality,
      viewerCaseIds: viewerSeries.map((item) => item.caseId),
      viewerLayout,
      focusedViewerIndex,
      updatedAt: new Date().toISOString()
    };
  }

  async function restoreDraftSession(draft: ActiveDraftPayload) {
    setRestoringDraft(true);
    try {
      resetSessionState();
      setSelectedCaseId(draft.caseId);
      const detail = await window.workbench.getCase(draft.caseId);
      setCaseDetail(detail);
      setReaderId(draft.readerId || 'reader-001');
      setDescription(draft.description || withTemplate(DESCRIPTION_TEMPLATE, detail.aiDescription || ''));
      setDiagnosis(draft.diagnosis || withTemplate(DIAGNOSIS_TEMPLATE, detail.aiDiagnosis || ''));
      setStartedAt(draft.startedAt || new Date().toISOString());
      setWritingStartedAt(draft.writingStartedAt || draft.startedAt || new Date().toISOString());
      setReasoningRequestedAt(draft.reasoningRequestedAt || '');
      setReasoningShownAt(draft.reasoningShownAt || '');
      setSubmitOpenedAt(draft.submitOpenedAt || null);
      setTaskElapsedMs(Number(draft.taskElapsedMs) || 0);
      setTotalElapsedMs(Number(draft.totalElapsedMs) || 0);
      setTaskRunning(Boolean(draft.taskRunning));
      setTotalRunning(Boolean(draft.totalRunning));
      setViewedReasoning(Boolean(draft.viewedReasoning));
      setReasoningPanelOpen(Boolean(draft.viewedReasoning));
      setSavedBeforeReasoning(draft.savedBeforeReasoning || '');
      setReasoningConfidence(draft.reasoningConfidence || '');
      setReasoningPurposes(Array.isArray(draft.reasoningPurposes) ? draft.reasoningPurposes : []);
      setReasoningGoalAchieved(draft.reasoningGoalAchieved || '');
      setFinalConfidence(draft.finalConfidence || '');
      setReportQuality(draft.reportQuality || emptyReportQuality());
      await loadViewerSeriesBundle(draft.viewerCaseIds?.length ? draft.viewerCaseIds : [draft.caseId], draft.viewerLayout, Number(draft.focusedViewerIndex) || 0);
      setStatus(`已恢复病例 ${draft.caseId} 的未提交现场。`);
    } finally {
      setRestoringDraft(false);
    }
  }

  async function startReading() {
    if (!selectedCaseId) return;
    if (active) {
      setStatus('当前任务尚未提交，不能重新开始阅片。');
      return;
    }
    if (currentCaseCompleted) {
      setStatus('该病例已完成，不能再次开始阅片。');
      return;
    }
    const draft = await window.workbench.getDraft(selectedCaseId);
    if (draft) {
      await restoreDraftSession(draft);
      return;
    }
    const currentDescription = description;
    const currentDiagnosis = diagnosis;
    resetSessionState();
    const now = new Date().toISOString();
    setStartedAt(now);
    setWritingStartedAt(now);
    setTaskRunning(true);
    setTotalRunning(true);
    setStatus(`已开始阅片：${selectedCaseId}`);
    const detail = caseDetail?.caseId === selectedCaseId ? caseDetail : await window.workbench.getCase(selectedCaseId);
    setCaseDetail(detail);
    setDescription(currentDescription || withTemplate(DESCRIPTION_TEMPLATE, detail.aiDescription || ''));
    setDiagnosis(currentDiagnosis || withTemplate(DIAGNOSIS_TEMPLATE, detail.aiDiagnosis || ''));
    await loadSeriesIntoViewer(selectedCaseId);
  }

  function resumeTaskTimerAfterReasoning() {
    if (active && viewedReasoning && !taskRunning) {
      setTaskRunning(true);
      setStatus('已继续报告书写，当前用时重新开始计时。');
    }
  }

  function handleReasoningPanelDragStart(event: React.PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button')) return;
    setReasoningDragging({
      startX: event.clientX,
      startY: event.clientY,
      right: reasoningPanelPosition.right,
      bottom: reasoningPanelPosition.bottom
    });
  }

  function updateReasoningPurpose(option: string, checked: boolean) {
    setReasoningPurposes((current) => (checked ? (current.includes(option) ? current : [...current, option]) : current.filter((item) => item !== option)));
  }

  function openReasoningSurvey() {
    if (!active || !selectedCaseId) return;
    if (viewedReasoning) {
      setReasoningPanelOpen(true);
      return;
    }
    setReasoningRequestedAt(new Date().toISOString());
    setModalMode('reasoning');
  }

  function confirmShowReasoning() {
    if (!reasoningConfidence || !reasoningPurposes.length) return;
    const now = new Date().toISOString();
    setSavedBeforeReasoning(JSON.stringify({ description, diagnosis, savedAt: now }, null, 2));
    setReasoningShownAt(now);
    setViewedReasoning(true);
    setReasoningPanelOpen(true);
    setTaskElapsedMs(0);
    setTaskRunning(false);
    setModalMode(null);
    setStatus('已显示推理内容，并自动保存显示前的报告文本。继续书写时当前用时将重新计时。');
  }

  function restoreReportTemplate() {
    setDescription(DESCRIPTION_TEMPLATE);
    setDiagnosis(DIAGNOSIS_TEMPLATE);
    setStatus('已恢复报告模板。');
  }

  function clearReport() {
    setDescription('');
    setDiagnosis('');
    setStatus('已清空当前报告。');
  }

  function openSubmitSurvey() {
    if (!active || !selectedCaseId) return;
    setSubmitOpenedAt(new Date().toISOString());
    setModalMode('submit');
  }

  async function submitSession() {
    if (!selectedCaseId || !currentCaseSummary || !startedAt || !writingStartedAt) return;
    if (!finalConfidence) {
      setStatus('请选择最终把握程度后再提交。');
      return;
    }
    if (viewedReasoning && !reasoningGoalAchieved) {
      setStatus('请填写推理目的是否实现后再提交。');
      return;
    }
    if (!reportQualityCompleted) {
      setStatus('请完成全部报告质量评分后再提交。');
      return;
    }

    const payload: SaveSessionPayload = {
      readerId,
      caseId: selectedCaseId,
      modality: currentCaseSummary.modality,
      patientId: currentCaseSummary.patientId,
      startedAt,
      submittedAt: new Date().toISOString(),
      writingStartedAt,
      diagnosisHintSavedAt: '',
      reasoningRequestedAt,
      reasoningShownAt,
      submitOpenedAt: submitOpenedAt || '',
      taskElapsedMs,
      totalElapsedMs,
      viewedReasoning,
      description,
      diagnosis,
      savedBeforeDiagnosis: '',
      savedBeforeReasoning,
      finalDescription: description,
      finalDiagnosis: diagnosis,
      timingEvents: { focusedViewerIndex },
      reasoningConfidence,
      reasoningPurposes,
      finalConfidence,
      reportQuality,
      reasoningGoalAchieved,
      reasoningQuality: { caseFit: 0, medicalProfessionalism: 0, value: 0 }
    };

    try {
      const result = await window.workbench.saveSession(payload);
      await window.workbench.deleteDraft(selectedCaseId);
      setLastSessionId(result.id);
      setCompletedCaseIds((current) => (current.includes(selectedCaseId) ? current : [...current, selectedCaseId]));
      setDraftCaseIds((current) => current.filter((item) => item !== selectedCaseId));
      setTaskRunning(false);
      setTotalRunning(false);
      setStartedAt(null);
      setWritingStartedAt(null);
      setSubmitOpenedAt(null);
      setReasoningPanelOpen(false);
      setModalMode(null);
      setStatus(`病例 ${selectedCaseId} 已提交。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '提交失败。');
    }
  }

  async function exportSessions(format: 'csv' | 'json') {
    setExportingData(true);
    try {
      const result = await window.workbench.exportSessions(format);
      if ('filePath' in result) setStatus(`已导出到 ${result.filePath}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '导出失败。');
    } finally {
      setExportingData(false);
    }
  }

  function applyImportedData(result: ImportDataResult) {
    if (!('cases' in result)) return;
    const imported = result;
    setCases(imported.cases);
    setCaseSearch('');
    setModalityFilter('all');
    setShowOnlyPending(false);
    setCompletedCaseIds((current) => current.filter((caseId) => imported.cases.some((item) => item.caseId === caseId)));
    setDraftCaseIds((current) => current.filter((caseId) => imported.cases.some((item) => item.caseId === caseId)));

    if (imported.cases.length) {
      const stillExists = imported.cases.some((item) => item.caseId === selectedCaseId);
      const nextCaseId = stillExists ? selectedCaseId : imported.cases[0].caseId;
      setSelectedCaseId(nextCaseId);
      setStatus(`导入完成：识别到 ${imported.cases.length} 个病例、${imported.dicomFiles} 个 DICOM 文件。请选择病例后点击“开始阅片”。`);
    } else {
      setSelectedCaseId('');
      setCaseDetail(null);
      setStatus('导入完成，但没有识别到病例。请确认 DICOM 文件位于病例文件夹内。');
    }
  }

  async function handleDropCase(caseId: string, drop: DockDrop) {
    setLoadingImages(true);
    setViewerError('');
    try {
      const nextSeries = await buildSeries(caseId);
      if (!nextSeries) return;
      setViewerSeries((current) => {
        if (!current.length) {
          setViewerLayout('single');
          return [nextSeries];
        }
        if (drop.zone === 'center') {
          const cloned = [...current];
          cloned[drop.targetIndex] = nextSeries;
          return cloned;
        }
        if (current.length === 1) {
          setViewerLayout('two-horizontal');
          return drop.zone === 'left' || drop.zone === 'top' ? [nextSeries, current[0]] : [current[0], nextSeries];
        }
        if (current.length === 2) {
          const insertIndex = drop.zone === 'left' || drop.zone === 'top' ? drop.targetIndex : drop.targetIndex + 1;
          setViewerLayout(layoutForThreePanes(drop));
          return insertAt(current, insertIndex, nextSeries).slice(0, 3);
        }
        const insertIndex = drop.zone === 'left' || drop.zone === 'top' ? drop.targetIndex : drop.targetIndex + 1;
        const inserted = insertAt(current, insertIndex, nextSeries).slice(0, 4);
        setViewerLayout(normalizedLayout(inserted.length));
        return inserted;
      });
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : '拖入病例失败。');
    } finally {
      setLoadingImages(false);
      setDraggingCaseId('');
    }
  }

  function closeSeries(index: number) {
    setViewerSeries((current) => {
      const next = current.filter((_, itemIndex) => itemIndex !== index);
      setViewerLayout(normalizedLayout(next.length));
      return next;
    });
  }

  function renderCaseItem(item: WorkbenchCase) {
    const selected = item.caseId === selectedCaseId;
    const completed = completedCaseIds.includes(item.caseId);
    const draft = draftCaseIds.includes(item.caseId);
    return (
      <button
        key={item.caseId}
        type="button"
        data-case-id={item.caseId}
        className={`case-item ${selected ? 'selected' : ''} ${completed ? 'completed' : ''} ${draft ? 'draft' : ''}`}
        onClick={() => {
          setSelectedCaseId(item.caseId);
          if (active) void loadSeriesIntoViewer(item.caseId, 0);
        }}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData('application/x-workbench-case', item.caseId);
          event.dataTransfer.setData('text/plain', item.caseId);
          setDraggingCaseId(item.caseId);
        }}
        onDragEnd={() => setDraggingCaseId('')}
      >
        <div>
          <strong>{item.caseId}</strong>
          <small>{item.patientId || '未提供患者编号'}</small>
        </div>
        <span className={`case-tag ${completed ? 'done' : draft ? 'draft' : 'pending'}`}>{completed ? '已完成' : draft ? '未提交' : item.modality || 'DICOM'}</span>
      </button>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-backdrop" />
      <div className="app">
        <aside className="case-sidebar">
          <section className="card-panel app-title">
            <div className="title-mark">
              <Database size={20} />
            </div>
            <div>
              <span className="eyebrow">DICOM Reading Workbench</span>
              <strong>阅片实验工作台</strong>
              <span>主页面保留核心阅片流程，导入与导出放在左上角系统菜单中。</span>
            </div>
          </section>

          <section className="card-panel compact-panel">
            <div className="reader-field">
              <label htmlFor="reader-id">阅片者编号</label>
              <input id="reader-id" value={readerId} onChange={(event) => setReaderId(event.target.value)} />
            </div>
          </section>

          <section className="card-panel compact-panel filters-panel">
            <div className="section-caption">
              <span className="eyebrow">Cases</span>
              <strong>病例筛选</strong>
            </div>
            <label className="search-box">
              <Search size={16} />
              <input placeholder="搜索病例编号 / 模态 / 患者编号" value={caseSearch} onChange={(event) => setCaseSearch(event.target.value)} />
            </label>
            <div className="filter-row">
              <label>
                <Filter size={14} />
                <select value={modalityFilter} onChange={(event) => setModalityFilter(event.target.value as 'all' | 'CT' | 'MRI' | 'DICOM')}>
                  <option value="all">全部模态</option>
                  <option value="CT">CT</option>
                  <option value="MRI">MRI</option>
                  <option value="DICOM">其他 DICOM</option>
                </select>
              </label>
              <label className="toggle-check">
                <input type="checkbox" checked={showOnlyPending} onChange={(event) => setShowOnlyPending(event.target.checked)} />
                <span>只看未完成</span>
              </label>
            </div>
            <div className="stats-row">
              <span className="progress-pill idle">总数 {cases.length}</span>
              <span className="progress-pill ready">待完成 {pendingCount}</span>
              <span className="progress-pill success">已完成 {completedCount}</span>
              <span className="progress-pill draft">未提交 {draftCount}</span>
            </div>
          </section>

          <section className="card-panel compact-panel case-list-panel">
            <div className="case-heading">
              <strong>病例列表</strong>
              <span>{loadingCases ? '正在扫描病例...' : `完成度 ${completionPercent}%`}</span>
            </div>
            <div className="case-list">
              {filteredCases.map(renderCaseItem)}
              {!filteredCases.length && <div className="empty-hint">当前筛选条件下没有病例。</div>}
            </div>
          </section>
        </aside>

        <main className="workspace">
          <section className="card-panel workspace-header">
            <div className="header-main">
              <div>
                <span className="eyebrow">Current Case</span>
                <h1>{selectedCaseId || '请选择病例'}</h1>
                <p>
                  {currentCaseSummary
                    ? `${currentCaseSummary.modality || 'DICOM'} · ${currentCaseSummary.patientId || '未提供患者编号'}${currentCaseCompleted ? ' · 已完成' : currentCaseHasDraft ? ' · 有未提交现场' : ''}`
                    : '左侧选择病例后开始阅片。'}
                </p>
              </div>
              <div className="header-actions">
                <button type="button" onClick={() => void startReading()} disabled={!selectedCaseId || loadingImages || active || currentCaseCompleted || restoringDraft}>
                  <Play size={16} />
                  {currentCaseHasDraft ? '恢复阅片' : '开始阅片'}
                </button>
                <button type="button" onClick={openReasoningSurvey} disabled={!active}>
                  <Eye size={16} />
                  显示推理
                </button>
                <button type="button" onClick={openSubmitSurvey} disabled={!active}>
                  <Send size={16} />
                  提交结果
                </button>
              </div>
            </div>
            <div className="header-meta">
              <div className="timer-box">
                <strong>当前用时</strong>
                <span>{formatDuration(taskElapsedMs)}</span>
              </div>
              <div className="timer-box">
                <strong>累计用时</strong>
                <span>{formatDuration(totalElapsedMs)}</span>
              </div>
              <div className="timer-box status-box">
                <strong>状态</strong>
                <span>{active ? '进行中' : restoringDraft ? '恢复中' : '待开始'}</span>
              </div>
            </div>
          </section>

          <section className="workspace-grid">
            <div className="viewer-panel card-panel compact-panel">
              <DicomViewer
                enabled={active}
                allowDrop
                series={viewerSeries}
                layoutKind={viewerLayout}
                loading={loadingImages}
                error={viewerError}
                draggingCaseId={draggingCaseId}
                onDropCase={(caseId, drop) => void handleDropCase(caseId, drop)}
                onCloseSeries={closeSeries}
                onActivePaneChange={setFocusedViewerIndex}
              />
            </div>

            <section className="report-panel card-panel compact-panel">
              <div className="editor-card-head">
                <div>
                  <span className="eyebrow">Report</span>
                  <strong>报告填写</strong>
                </div>
                <button type="button" onClick={restoreReportTemplate}>
                  <Save size={15} />
                  恢复模板
                </button>
              </div>

              <label className="editor-block stretch">
                <div className="editor-label">
                  <strong>影像所见</strong>
                  <span>{findingsLength} 字</span>
                </div>
                <textarea
                  value={description}
                  onFocus={resumeTaskTimerAfterReasoning}
                  onKeyDown={resumeTaskTimerAfterReasoning}
                  onPaste={resumeTaskTimerAfterReasoning}
                  onChange={(event) => {
                    resumeTaskTimerAfterReasoning();
                    setDescription(event.target.value);
                  }}
                  placeholder={DESCRIPTION_TEMPLATE}
                />
              </label>

              <label className="editor-block stretch">
                <div className="editor-label">
                  <strong>诊断意见</strong>
                  <span>{diagnosisLength} 字</span>
                </div>
                <textarea
                  value={diagnosis}
                  onFocus={resumeTaskTimerAfterReasoning}
                  onKeyDown={resumeTaskTimerAfterReasoning}
                  onPaste={resumeTaskTimerAfterReasoning}
                  onChange={(event) => {
                    resumeTaskTimerAfterReasoning();
                    setDiagnosis(event.target.value);
                  }}
                  placeholder={DIAGNOSIS_TEMPLATE}
                />
              </label>
            </section>
          </section>

          <footer className="statusbar card-panel">
            <span>{status || '准备就绪。'}</span>
            <span>{lastSessionId ? `最近一次提交记录 ID：${lastSessionId}` : exportingData ? '正在导出数据...' : ''}</span>
          </footer>
        </main>
      </div>

      {reasoningPanelOpen && (
        <aside className={`reasoning-float card-panel ${reasoningDragging ? 'dragging' : ''}`} style={{ right: `${reasoningPanelPosition.right}px`, bottom: `${reasoningPanelPosition.bottom}px` }}>
          <div className="reasoning-head" onPointerDown={handleReasoningPanelDragStart}>
            <div>
              <span className="eyebrow">Reasoning</span>
              <strong>推理内容</strong>
            </div>
            <button type="button" onClick={() => setReasoningPanelOpen(false)}>
              关闭
            </button>
          </div>
          <pre>{reasoningText}</pre>
        </aside>
      )}

      {modalMode === 'reasoning' && (
        <div className="modal-backdrop">
          <section className="modal-card large">
            <h2>显示推理前确认</h2>
            <label className="field-block">
              <span>当前把握程度</span>
              <select value={reasoningConfidence} onChange={(event) => setReasoningConfidence(event.target.value)}>
                <option value="">请选择</option>
                {CONFIDENCE_OPTIONS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <section className="field-block">
              <span>查看推理目的</span>
              <div className="checkbox-list">
                {REASONING_PURPOSE_OPTIONS.map((item, index) => (
                  <label key={item} className="check-item">
                    <input type="checkbox" checked={reasoningPurposes.includes(item)} onChange={(event) => updateReasoningPurpose(item, event.target.checked)} />
                    <span>{String.fromCharCode(65 + index)}. {item}</span>
                  </label>
                ))}
              </div>
            </section>

            <div className="modal-actions">
              <button type="button" onClick={() => setModalMode(null)}>
                取消
              </button>
              <button type="button" onClick={confirmShowReasoning} disabled={!reasoningConfidence || !reasoningPurposes.length}>
                确认显示推理
              </button>
            </div>
          </section>
        </div>
      )}

      {modalMode === 'submit' && (
        <div className="modal-backdrop">
          <section className="modal-card large">
            <h2>提交病例</h2>
            <div className="field-grid submit-grid">
              <label className="field-block">
                <span>最终把握程度</span>
                <select value={finalConfidence} onChange={(event) => setFinalConfidence(event.target.value)}>
                  <option value="">请选择</option>
                  {CONFIDENCE_OPTIONS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              {viewedReasoning && (
                <label className="field-block">
                  <span>推理目的是否实现</span>
                  <select value={reasoningGoalAchieved} onChange={(event) => setReasoningGoalAchieved(event.target.value)}>
                    <option value="">请选择</option>
                    {REASONING_GOAL_OPTIONS.map((item, index) => (
                      <option key={item} value={item}>
                        {String.fromCharCode(65 + index)}. {item}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <div className="rating-grid single-column">
              <section>
                <h3>报告质量</h3>
                {Object.entries(REPORT_QUALITY_LABELS).map(([key, label]) => (
                  <label key={key} className="rating-item">
                    <div>
                      <strong>{label}</strong>
                      <span>1 分 - 5 分</span>
                    </div>
                    <StarRating value={reportQuality[key as keyof ReportQuality]} onChange={(value) => setReportQuality((current) => ({ ...current, [key]: value }))} />
                  </label>
                ))}
              </section>
            </div>

            <div className="modal-actions">
              <button type="button" onClick={() => setModalMode(null)}>
                返回修改
              </button>
              <button type="button" onClick={() => void submitSession()} disabled={!finalConfidence || !reportQualityCompleted || (viewedReasoning && !reasoningGoalAchieved)}>
                确认提交
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
