export type WorkbenchCase = {
  caseId: string;
  modality: string;
  patientId: string;
  imageFolder: string;
  dicomCount: number;
  aiDescription: string;
  aiDiagnosis: string;
  reasoning: string;
  gtDescription: string;
  gtDiagnosis: string;
  gtReasoning: string;
  supplementalReports: SupplementalReport[];
};

export type CaseDetail = Omit<WorkbenchCase, 'dicomCount'> & {
  dicomFiles: string[];
};

export type SupplementalReport = {
  expert?: string;
  id?: string;
  description?: string;
  diagnosis?: string;
  other?: string;
};

export type DicomFilePayload = {
  filePath: string;
  name: string;
  data: ArrayBuffer;
};

export type ViewerSeries = {
  id: string;
  caseId: string;
  label: string;
  images: import('./dicom').ParsedDicomImage[];
};

export type ExternalDicomFolder = {
  folder: string;
  dicomFiles: string[];
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  createdAt: string;
  rootPath: string;
  rawPath: string;
  dbPath: string;
};

export type ReportQuality = {
  structure: number;
  localization: number;
  feature: number;
  accuracy: number;
  usability: number;
};

export type ReasoningQuality = {
  caseFit: number;
  medicalProfessionalism: number;
  value: number;
};

export type SaveSessionPayload = {
  readerId: string;
  caseId: string;
  modality: string;
  patientId: string;
  startedAt: string;
  submittedAt: string;
  writingStartedAt: string;
  diagnosisHintSavedAt: string;
  reasoningRequestedAt: string;
  reasoningShownAt: string;
  submitOpenedAt: string;
  taskElapsedMs: number;
  totalElapsedMs: number;
  viewedReasoning: boolean;
  description: string;
  diagnosis: string;
  savedBeforeDiagnosis: string;
  savedBeforeReasoning: string;
  finalDescription: string;
  finalDiagnosis: string;
  timingEvents: Record<string, unknown>;
  reasoningConfidence: string;
  reasoningPurposes: string[];
  finalConfidence: string;
  reportQuality: ReportQuality;
  reasoningGoalAchieved: string;
  reasoningQuality: ReasoningQuality;
};

export type ActiveDraftPayload = {
  readerId: string;
  caseId: string;
  modality: string;
  patientId: string;
  startedAt: string;
  writingStartedAt: string;
  diagnosisHintSavedAt: string;
  reasoningRequestedAt: string;
  reasoningShownAt: string;
  submitOpenedAt: string;
  taskElapsedMs: number;
  totalElapsedMs: number;
  taskRunning: boolean;
  totalRunning: boolean;
  viewedReasoning: boolean;
  description: string;
  diagnosis: string;
  savedBeforeDiagnosis: string;
  savedBeforeReasoning: string;
  reasoningConfidence: string;
  reasoningPurposes: string[];
  reasoningGoalAchieved: string;
  finalConfidence: string;
  reportQuality: ReportQuality;
  reasoningQuality: ReasoningQuality;
  viewerCaseIds: string[];
  viewerLayout: string;
  focusedViewerIndex: number;
  updatedAt: string;
};

export type ImportDataResult =
  | { canceled: true }
  | {
      canceled: false;
      source: string;
      destination: string;
      copied: boolean;
      workspace: WorkspaceSummary;
      dicomFiles: number;
      jsonFiles: number;
      cases: WorkbenchCase[];
    };

declare global {
  interface Window {
    workbench: {
      scanCases: () => Promise<WorkbenchCase[]>;
      listWorkspaces: () => Promise<WorkspaceSummary[]>;
      getCurrentWorkspace: () => Promise<WorkspaceSummary | null>;
      createWorkspace: (name: string) => Promise<{ workspace: WorkspaceSummary; cases: WorkbenchCase[] }>;
      switchWorkspace: (workspaceId: string) => Promise<{ workspace: WorkspaceSummary; cases: WorkbenchCase[] }>;
      importDataFolder: () => Promise<ImportDataResult>;
      onDataImported: (callback: (result: ImportDataResult) => void) => () => void;
      onDataImportError: (callback: (message: string) => void) => () => void;
      onMenuAction: (callback: (action: string) => void) => () => void;
      getCase: (caseId: string) => Promise<CaseDetail>;
      readDicomFiles: (filePaths: string[]) => Promise<DicomFilePayload[]>;
      saveSession: (payload: SaveSessionPayload) => Promise<{ id: number }>;
      exportSessions: (format: 'csv' | 'json' | 'docx' | 'pdf') => Promise<{ canceled: true } | { canceled: false; filePath: string }>;
      listSessions: () => Promise<Record<string, unknown>[]>;
      saveDraft: (payload: ActiveDraftPayload) => Promise<{ ok: true }>;
      getDraft: (caseId: string) => Promise<ActiveDraftPayload | null>;
      listDrafts: () => Promise<ActiveDraftPayload[]>;
      deleteDraft: (caseId: string) => Promise<{ ok: true }>;
    };
  }
}
