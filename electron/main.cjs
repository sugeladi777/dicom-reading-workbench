const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const extractZip = require('extract-zip');
const initSqlJs = require('sql.js');

const isDevServer = process.env.WORKBENCH_DEV === '1';
const appRoot = app.isPackaged ? path.join(__dirname, '..') : process.cwd();
const isPortableWindows = app.isPackaged && process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR;
const userRoot = app.isPackaged
  ? (isPortableWindows ? process.env.PORTABLE_EXECUTABLE_DIR : app.getPath('userData'))
  : process.cwd();
const dataRoot = path.join(userRoot, 'data');
const rawRoot = path.join(dataRoot, 'raw');
const importedRoot = path.join(rawRoot, 'imported');
const dbPath = path.join(dataRoot, 'workbench.sqlite');

let mainWindow;
let db;
let caseCache = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else out.push(fullPath);
    }
  }
  return out;
}

function naturalSort(files) {
  return files.sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-CN', { numeric: true }));
}

function safeFolderName(name) {
  return name.replace(/[<>:"/\|?*\u0000-\u001f]/g, '_').trim() || '未命名';
}

function uniqueImportDestination(sourceFolder) {
  ensureDir(importedRoot);
  const parsed = path.parse(sourceFolder);
  const base = safeFolderName(parsed.ext.toLowerCase() === '.zip' ? parsed.name : path.basename(sourceFolder));
  let destination = path.join(importedRoot, base);
  let suffix = 1;
  while (fs.existsSync(destination)) {
    suffix += 1;
    destination = path.join(importedRoot, base + '-' + suffix);
  }
  return destination;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function importDataFolderFromDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择数据文件夹',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return importFolder(result.filePaths[0]);
}

async function importDataZipFromDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 ZIP 压缩包',
    properties: ['openFile'],
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return importZip(result.filePaths[0]);
}

function summarizeImportedSource(source, destination, copied) {
  const sourceFiles = walkFiles(destination);
  const sourceDicomFiles = sourceFiles.filter((file) => isDicomFile(file));
  const sourceJsonFiles = sourceFiles.filter((file) => file.toLowerCase().endsWith('.json'));
  if (!sourceDicomFiles.length && !sourceJsonFiles.length) {
    throw new Error('导入目录中未找到可用的 DICOM 或 JSON 文件。');
  }
  const cases = scanCasesFromDisk();
  return {
    canceled: false,
    source,
    destination,
    copied,
    dicomFiles: sourceDicomFiles.length,
    jsonFiles: sourceJsonFiles.length,
    cases
  };
}

async function importFolder(source) {
  let destination = source;
  let copied = false;
  if (path.resolve(source) !== path.resolve(rawRoot) && !isInside(rawRoot, source)) {
    destination = uniqueImportDestination(source);
    await fs.promises.cp(source, destination, { recursive: true });
    copied = true;
  }
  return summarizeImportedSource(source, destination, copied);
}

async function importZip(source) {
  const destination = uniqueImportDestination(source);
  ensureDir(destination);
  await extractZip(source, { dir: destination });
  return summarizeImportedSource(source, destination, true);
}

function notifyImportResult(result) {
  if (result.canceled) return;
  mainWindow?.webContents.send('data:imported', result);
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '导入完成',
    message: `已导入 ${result.dicomFiles} 个 DICOM 文件，${result.jsonFiles} 个 JSON 文件。`
  });
}

function notifyImportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  mainWindow?.webContents.send('data:import-error', message);
  dialog.showErrorBox('导入失败', message);
}

function emitMenuAction(action) {
  mainWindow?.webContents.send('menu:action', action);
}

function setApplicationMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        {
          label: '导入文件夹...',
          accelerator: 'CmdOrCtrl+I',
          click: async () => {
            try {
              notifyImportResult(await importDataFolderFromDialog());
            } catch (error) {
              notifyImportError(error);
            }
          }
        },
        {
          label: '导入 ZIP...',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: async () => {
            try {
              notifyImportResult(await importDataZipFromDialog());
            } catch (error) {
              notifyImportError(error);
            }
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '工具',
      submenu: [
        {
          label: '重新扫描病例',
          accelerator: 'F5',
          click: () => emitMenuAction('refresh-cases')
        },
        {
          label: '恢复报告模板',
          click: () => emitMenuAction('restore-report-template')
        },
        {
          label: '清空当前报告',
          click: () => emitMenuAction('clear-report')
        }
      ]
    },
    {
      label: '导出',
      submenu: [
        {
          label: '导出 CSV',
          click: () => emitMenuAction('export-csv')
        },
        {
          label: '导出 JSON',
          click: () => emitMenuAction('export-json')
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

function modalityFromCaseId(caseId, fallback = '') {
  const upper = `${caseId} ${fallback}`.toUpperCase();
  if (upper.includes('MRI') || upper.includes('MR')) return 'MRI';
  if (upper.includes('CT')) return 'CT';
  return 'DICOM';
}

function isDicomFile(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.dcm') || lower.endsWith('.dicom') || lower.endsWith('.ima')) return true;
  if (lower.endsWith('.json') || lower.endsWith('.zip') || lower.endsWith('.exe')) return false;
  try {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(132);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return bytesRead >= 132 && buffer.slice(128, 132).toString('ascii') === 'DICM';
  } catch {
    return false;
  }
}

function normalizeReportJson(value) {
  if (!value || Array.isArray(value)) return {};
  return {
    patientId: value.patient_id || value.patientId || '',
    aiDescription: value.description || '',
    aiDiagnosis: value.diagnosis || '',
    reasoning: value.reasoning || '',
    gtDescription: value.gt_description || value.gtDescription || '',
    gtDiagnosis: value.gt_diagnosis || value.gtDiagnosis || '',
    gtReasoning: value.gt_reasoning || value.gtReasoning || ''
  };
}

function escapeControlCharactersInJsonStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && char === '\n') {
      out += '\\n';
      continue;
    }
    if (inString && char === '\r') {
      out += '\\r';
      continue;
    }
    if (inString && char === '\t') {
      out += '\\t';
      continue;
    }
    out += char;
  }

  return out;
}

function parseReportJsonFile(file) {
  const buffer = fs.readFileSync(file);
  const candidates = [
    buffer.toString('utf8'),
    new TextDecoder('gb18030').decode(buffer)
  ];

  for (const text of candidates) {
    for (const candidate of [text, escapeControlCharactersInJsonStrings(text)]) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Try the next decoding or relaxed JSON variant.
      }
    }
  }

  throw new Error('无法解析 JSON，请检查编码或字符串换行格式。');
}

function scanCasesFromDisk() {
  const files = walkFiles(rawRoot);
  const dcmByDir = new Map();
  const primaryReports = new Map();
  const supplementalReports = new Map();

  for (const file of files) {
    const lower = file.toLowerCase();
    if (isDicomFile(file)) {
      const dir = path.dirname(file);
      if (!dcmByDir.has(dir)) dcmByDir.set(dir, []);
      dcmByDir.get(dir).push(file);
    }

    if (lower.endsWith('.json')) {
      const base = path.basename(file, '.json');
      try {
        const parsed = parseReportJsonFile(file);
        if (Array.isArray(parsed)) supplementalReports.set(base, parsed);
        else primaryReports.set(base, normalizeReportJson(parsed));
      } catch (error) {
        console.warn(`Failed to parse report JSON: ${file}`, error);
      }
    }
  }

  const cases = new Map();
  for (const [dir, dcmFiles] of dcmByDir.entries()) {
    const caseId = path.basename(dir);
    const primary = primaryReports.get(caseId) || {};
    cases.set(caseId, {
      caseId,
      modality: modalityFromCaseId(caseId, dir),
      patientId: primary.patientId || '',
      imageFolder: dir,
      dicomFiles: naturalSort(dcmFiles),
      aiDescription: primary.aiDescription || '',
      aiDiagnosis: primary.aiDiagnosis || '',
      reasoning: primary.reasoning || '',
      gtDescription: primary.gtDescription || '',
      gtDiagnosis: primary.gtDiagnosis || '',
      gtReasoning: primary.gtReasoning || '',
      supplementalReports: supplementalReports.get(caseId) || []
    });
  }

  for (const [caseId, primary] of primaryReports.entries()) {
    if (cases.has(caseId)) {
      const current = cases.get(caseId);
      cases.set(caseId, { ...current, ...primary, caseId, supplementalReports: current.supplementalReports || [] });
    } else {
      cases.set(caseId, {
        caseId,
        modality: modalityFromCaseId(caseId),
        patientId: primary.patientId || '',
        imageFolder: '',
        dicomFiles: [],
        ...primary,
        supplementalReports: supplementalReports.get(caseId) || []
      });
    }
  }

  for (const [caseId, reports] of supplementalReports.entries()) {
    if (cases.has(caseId)) cases.get(caseId).supplementalReports = reports;
  }

  caseCache = cases;
  return [...cases.values()]
    .sort((a, b) => a.caseId.localeCompare(b.caseId, 'zh-CN', { numeric: true }))
    .map((item) => ({
      ...item,
      dicomCount: item.dicomFiles.length,
      dicomFiles: undefined
    }));
}

async function initDatabase() {
  ensureDir(dataRoot);
  const SQL = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
  });
  db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reader_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      modality TEXT,
      patient_id TEXT,
      started_at TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      writing_started_at TEXT,
      diagnosis_hint_saved_at TEXT,
      reasoning_requested_at TEXT,
      reasoning_shown_at TEXT,
      submit_opened_at TEXT,
      task_elapsed_ms INTEGER NOT NULL,
      total_elapsed_ms INTEGER NOT NULL,
      viewed_reasoning INTEGER NOT NULL,
      timing_events_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS report_drafts (
      session_id INTEGER PRIMARY KEY,
      description TEXT,
      diagnosis TEXT,
      saved_before_diagnosis TEXT,
      saved_before_reasoning TEXT,
      final_description TEXT,
      final_diagnosis TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS surveys (
      session_id INTEGER PRIMARY KEY,
      reasoning_confidence TEXT,
      reasoning_purposes_json TEXT,
      final_confidence TEXT,
      report_quality_json TEXT,
      reasoning_goal_achieved TEXT,
      reasoning_quality_json TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS active_drafts (
      case_id TEXT PRIMARY KEY,
      reader_id TEXT,
      modality TEXT,
      patient_id TEXT,
      started_at TEXT,
      writing_started_at TEXT,
      reasoning_requested_at TEXT,
      reasoning_shown_at TEXT,
      submit_opened_at TEXT,
      task_elapsed_ms INTEGER,
      total_elapsed_ms INTEGER,
      task_running INTEGER,
      total_running INTEGER,
      viewed_reasoning INTEGER,
      description TEXT,
      diagnosis TEXT,
      saved_before_reasoning TEXT,
      reasoning_confidence TEXT,
      reasoning_purposes_json TEXT,
      reasoning_goal_achieved TEXT,
      final_confidence TEXT,
      report_quality_json TEXT,
      reasoning_quality_json TEXT,
      viewer_case_ids_json TEXT,
      viewer_layout TEXT,
      focused_viewer_index INTEGER,
      updated_at TEXT
    );
  `);
  ensureColumn('sessions', 'writing_started_at', 'TEXT');
  ensureColumn('sessions', 'diagnosis_hint_saved_at', 'TEXT');
  ensureColumn('sessions', 'reasoning_requested_at', 'TEXT');
  ensureColumn('sessions', 'reasoning_shown_at', 'TEXT');
  ensureColumn('sessions', 'submit_opened_at', 'TEXT');
  ensureColumn('sessions', 'timing_events_json', 'TEXT');
  ensureColumn('report_drafts', 'saved_before_diagnosis', 'TEXT');
  ensureColumn('active_drafts', 'reasoning_quality_json', 'TEXT');
  flushDb();
}

function flushDb() {
  ensureDir(dataRoot);
  const data = db.export();
  fs.writeFileSync(`${dbPath}.tmp`, Buffer.from(data));
  fs.renameSync(`${dbPath}.tmp`, dbPath);
}

function dbRows(query, params = []) {
  const stmt = db.prepare(query);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function columnExists(table, column) {
  return dbRows(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

function ensureColumn(table, column, type) {
  if (!columnExists(table, column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function saveSession(payload) {
  const now = new Date().toISOString();
  const tx = db.prepare(`
    INSERT INTO sessions (
      reader_id, case_id, modality, patient_id, started_at, submitted_at,
      writing_started_at, diagnosis_hint_saved_at, reasoning_requested_at, reasoning_shown_at,
      submit_opened_at, task_elapsed_ms, total_elapsed_ms, viewed_reasoning, timing_events_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  tx.run([
    payload.readerId || 'anonymous',
    payload.caseId,
    payload.modality || '',
    payload.patientId || '',
    payload.startedAt,
    payload.submittedAt,
    payload.writingStartedAt || '',
    payload.diagnosisHintSavedAt || '',
    payload.reasoningRequestedAt || '',
    payload.reasoningShownAt || '',
    payload.submitOpenedAt || '',
    payload.taskElapsedMs || 0,
    payload.totalElapsedMs || 0,
    payload.viewedReasoning ? 1 : 0,
    JSON.stringify(payload.timingEvents || {}),
    now
  ]);
  tx.free();

  const sessionId = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];

  const draft = db.prepare(`
    INSERT INTO report_drafts (
      session_id, description, diagnosis, saved_before_diagnosis, saved_before_reasoning, final_description, final_diagnosis
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  draft.run([
    sessionId,
    payload.description || '',
    payload.diagnosis || '',
    payload.savedBeforeDiagnosis || '',
    payload.savedBeforeReasoning || '',
    payload.finalDescription || '',
    payload.finalDiagnosis || ''
  ]);
  draft.free();

  const survey = db.prepare(`
    INSERT INTO surveys (
      session_id, reasoning_confidence, reasoning_purposes_json, final_confidence,
      report_quality_json, reasoning_goal_achieved, reasoning_quality_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  survey.run([
    sessionId,
    payload.reasoningConfidence || '',
    JSON.stringify(payload.reasoningPurposes || []),
    payload.finalConfidence || '',
    JSON.stringify(payload.reportQuality || {}),
    payload.reasoningGoalAchieved || '',
    JSON.stringify(payload.reasoningQuality || {})
  ]);
  survey.free();

  db.run('DELETE FROM active_drafts WHERE case_id = ?', [payload.caseId]);
  flushDb();
  return { id: sessionId };
}

function saveDraft(payload) {
  const tx = db.prepare(`
    INSERT INTO active_drafts (
      case_id, reader_id, modality, patient_id, started_at, writing_started_at,
      reasoning_requested_at, reasoning_shown_at, submit_opened_at,
      task_elapsed_ms, total_elapsed_ms, task_running, total_running, viewed_reasoning,
      description, diagnosis, saved_before_reasoning,
      reasoning_confidence, reasoning_purposes_json, reasoning_goal_achieved, final_confidence,
      report_quality_json, reasoning_quality_json, viewer_case_ids_json, viewer_layout, focused_viewer_index, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_id) DO UPDATE SET
      reader_id = excluded.reader_id,
      modality = excluded.modality,
      patient_id = excluded.patient_id,
      started_at = excluded.started_at,
      writing_started_at = excluded.writing_started_at,
      reasoning_requested_at = excluded.reasoning_requested_at,
      reasoning_shown_at = excluded.reasoning_shown_at,
      submit_opened_at = excluded.submit_opened_at,
      task_elapsed_ms = excluded.task_elapsed_ms,
      total_elapsed_ms = excluded.total_elapsed_ms,
      task_running = excluded.task_running,
      total_running = excluded.total_running,
      viewed_reasoning = excluded.viewed_reasoning,
      description = excluded.description,
      diagnosis = excluded.diagnosis,
      saved_before_reasoning = excluded.saved_before_reasoning,
      reasoning_confidence = excluded.reasoning_confidence,
      reasoning_purposes_json = excluded.reasoning_purposes_json,
      reasoning_goal_achieved = excluded.reasoning_goal_achieved,
      final_confidence = excluded.final_confidence,
      report_quality_json = excluded.report_quality_json,
      reasoning_quality_json = excluded.reasoning_quality_json,
      viewer_case_ids_json = excluded.viewer_case_ids_json,
      viewer_layout = excluded.viewer_layout,
      focused_viewer_index = excluded.focused_viewer_index,
      updated_at = excluded.updated_at
  `);
  tx.run([
    payload.caseId,
    payload.readerId || '',
    payload.modality || '',
    payload.patientId || '',
    payload.startedAt || '',
    payload.writingStartedAt || '',
    payload.reasoningRequestedAt || '',
    payload.reasoningShownAt || '',
    payload.submitOpenedAt || '',
    payload.taskElapsedMs || 0,
    payload.totalElapsedMs || 0,
    payload.taskRunning ? 1 : 0,
    payload.totalRunning ? 1 : 0,
    payload.viewedReasoning ? 1 : 0,
    payload.description || '',
    payload.diagnosis || '',
    payload.savedBeforeReasoning || '',
    payload.reasoningConfidence || '',
    JSON.stringify(payload.reasoningPurposes || []),
    payload.reasoningGoalAchieved || '',
    payload.finalConfidence || '',
    JSON.stringify(payload.reportQuality || {}),
    JSON.stringify(payload.reasoningQuality || {}),
    JSON.stringify(payload.viewerCaseIds || []),
    payload.viewerLayout || '',
    payload.focusedViewerIndex || 0,
    payload.updatedAt || new Date().toISOString()
  ]);
  tx.free();
  flushDb();
  return { ok: true };
}

function mapDraftRow(row) {
  if (!row) return null;
  return {
    ...row,
    taskRunning: Boolean(row.task_running),
    totalRunning: Boolean(row.total_running),
    viewedReasoning: Boolean(row.viewed_reasoning),
    reasoningPurposes: JSON.parse(row.reasoning_purposes_json || '[]'),
    reportQuality: JSON.parse(row.report_quality_json || '{}'),
    reasoningQuality: JSON.parse(row.reasoning_quality_json || '{}'),
    viewerCaseIds: JSON.parse(row.viewer_case_ids_json || '[]')
  };
}

function getDraft(caseId) {
  const row = dbRows('SELECT * FROM active_drafts WHERE case_id = ? LIMIT 1', [caseId])[0];
  return mapDraftRow(row);
}

function listDrafts() {
  return dbRows('SELECT * FROM active_drafts ORDER BY updated_at DESC').map(mapDraftRow);
}

function deleteDraft(caseId) {
  db.run('DELETE FROM active_drafts WHERE case_id = ?', [caseId]);
  flushDb();
  return { ok: true };
}

function listSessions() {
  return dbRows(`
    SELECT
      s.*,
      d.description,
      d.diagnosis,
      d.saved_before_diagnosis,
      d.saved_before_reasoning,
      d.final_description,
      d.final_diagnosis,
      v.reasoning_confidence,
      v.reasoning_purposes_json,
      v.final_confidence,
      v.report_quality_json,
      v.reasoning_goal_achieved,
      v.reasoning_quality_json
    FROM sessions s
    LEFT JOIN report_drafts d ON d.session_id = s.id
    LEFT JOIN surveys v ON v.session_id = s.id
    ORDER BY s.id DESC
  `).map((row) => ({
    ...row,
    viewed_reasoning: Boolean(row.viewed_reasoning),
    timing_events: JSON.parse(row.timing_events_json || '{}'),
    reasoning_purposes: JSON.parse(row.reasoning_purposes_json || '[]'),
    report_quality: JSON.parse(row.report_quality_json || '{}'),
    reasoning_quality: JSON.parse(row.reasoning_quality_json || '{}')
  }));
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function compactReasoningQuality(value = {}) {
  return {
    符合医学知识: value.medicalProfessionalism || 0,
    对应本病例: value.caseFit || 0,
    有价值: value.value || 0
  };
}

function flattenSavedBeforeReasoning(value) {
  const parsed = parseSavedBeforeReasoning(value);
  return {
    查看推理前影像所见: parsed?.影像所见 || parsed?.['褰卞儚鎵€瑙?'] || '',
    查看推理前诊断意见: parsed?.诊断意见 || parsed?.['璇婃柇鎰忚'] || '',
    查看推理前保存时间: parsed?.保存时间 || parsed?.['淇濆瓨鏃堕棿'] || ''
  };
}

function sessionToCsvRecord(row) {
  const viewedReasoning = Boolean(row.viewed_reasoning);
  const savedBeforeReasoning = flattenSavedBeforeReasoning(row.saved_before_reasoning);
  return {
    记录编号: row.id,
    阅片者编号: row.reader_id || '',
    病例编号: row.case_id || '',
    模态: row.modality || '',
    患者编号: row.patient_id || '',
    开始阅片时间: row.started_at || '',
    开始书写时间: row.writing_started_at || '',
    查看推理点击时间: row.reasoning_requested_at || '',
    查看推理显示时间: row.reasoning_shown_at || '',
    打开提交问卷时间: row.submit_opened_at || '',
    提交时间: row.submitted_at || '',
    当前用时秒: secondsFromMs(row.task_elapsed_ms),
    累计用时秒: secondsFromMs(row.total_elapsed_ms),
    是否查看推理: viewedReasoning ? '是' : '否',
    查看推理前把握程度: row.reasoning_confidence || '',
    查看推理目的: viewedReasoning ? (row.reasoning_purposes || []).join('；') : '',
    推理目的是否实现: row.reasoning_goal_achieved || '',
    推理质量_符合医学知识: viewedReasoning ? row.reasoning_quality?.medicalProfessionalism || 0 : '',
    推理质量_对应本病例: viewedReasoning ? row.reasoning_quality?.caseFit || 0 : '',
    推理质量_有价值: viewedReasoning ? row.reasoning_quality?.value || 0 : '',
    最终把握程度: row.final_confidence || '',
    报告质量_结构完整性: row.report_quality?.structure || 0,
    报告质量_病灶定位: row.report_quality?.localization || 0,
    报告质量_特征描述: row.report_quality?.feature || 0,
    报告质量_诊断准确性: row.report_quality?.accuracy || 0,
    报告质量_整体可用性: row.report_quality?.usability || 0,
    查看推理前影像所见: viewedReasoning ? savedBeforeReasoning.查看推理前影像所见 : '',
    查看推理前诊断意见: viewedReasoning ? savedBeforeReasoning.查看推理前诊断意见 : '',
    最终影像所见: row.final_description || row.description || '',
    最终诊断意见: row.final_diagnosis || row.diagnosis || ''
  };
}

function sessionsToCsv(rows) {
  const records = rows.map(sessionToCsvRecord);
  const headers = records.length ? Object.keys(records[0]) : [
    '记录编号',
    '阅片者编号',
    '病例编号',
    '模态',
    '患者编号',
    '开始阅片时间',
    '开始书写时间',
    '查看推理点击时间',
    '查看推理显示时间',
    '打开提交问卷时间',
    '提交时间',
    '当前用时秒',
    '累计用时秒',
    '是否查看推理',
    '查看推理前把握程度',
    '查看推理目的',
    '推理目的是否实现',
    '推理质量_符合医学知识',
    '推理质量_对应本病例',
    '推理质量_有价值',
    '最终把握程度',
    '报告质量_结构完整性',
    '报告质量_病灶定位',
    '报告质量_特征描述',
    '报告质量_诊断准确性',
    '报告质量_整体可用性',
    '查看推理前影像所见',
    '查看推理前诊断意见',
    '最终影像所见',
    '最终诊断意见'
  ];
  const lines = [headers.map(csvCell).join(',')];
  for (const record of records) {
    lines.push(headers.map((key) => csvCell(record[key])).join(','));
  }
  return lines.join('\r\n');
}

function secondsFromMs(value) {
  return Math.round((Number(value) || 0) / 1000);
}

function compactReportQuality(value = {}) {
  return {
    结构完整性: value.structure || 0,
    病灶定位: value.localization || 0,
    特征描述: value.feature || 0,
    诊断准确性: value.accuracy || 0,
    整体可用性: value.usability || 0
  };
}

function parseSavedBeforeReasoning(value) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return {
      保存时间: parsed.savedAt || '',
      影像所见: parsed.description || '',
      诊断意见: parsed.diagnosis || ''
    };
  } catch {
    return { 原始内容: value };
  }
}

function sessionsToCompactJson(rows) {
  return rows.map((row) => {
    const viewedReasoning = Boolean(row.viewed_reasoning);
    const out = {
      记录编号: row.id,
      阅片者编号: row.reader_id || '',
      病例编号: row.case_id || '',
      模态: row.modality || '',
      患者编号: row.patient_id || '',
      开始时间: row.started_at || '',
      提交时间: row.submitted_at || '',
      当前用时秒: secondsFromMs(row.task_elapsed_ms),
      累计用时秒: secondsFromMs(row.total_elapsed_ms),
      是否查看推理: viewedReasoning ? '是' : '否',
      最终把握程度: row.final_confidence || '',
      报告质量评分: compactReportQuality(row.report_quality),
      影像所见: row.final_description || row.description || '',
      诊断意见: row.final_diagnosis || row.diagnosis || ''
    };

    if (viewedReasoning) {
      out.查看推理时间 = row.reasoning_shown_at || '';
      out.查看推理前把握程度 = row.reasoning_confidence || '';
      out.查看推理目的 = row.reasoning_purposes || [];
      out.推理目的是否实现 = row.reasoning_goal_achieved || '';
      out.查看推理前报告 = parseSavedBeforeReasoning(row.saved_before_reasoning);
    }

    return out;
  });
}

async function exportSessions(format) {
  const rows = listSessions();
  if ((format === 'docx' || format === 'pdf') && rows.length) {
    throw new Error('当前版本仅稳定支持导出 CSV 和 JSON，DOCX/PDF 导出能力尚未安装对应依赖。');
  }

  const extension = format === 'csv' ? 'csv' : format === 'json' ? 'json' : format === 'docx' ? 'docx' : 'pdf';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出实验结果',
    defaultPath: `实验结果导出.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  if (format === 'csv') fs.writeFileSync(result.filePath, `\ufeff${sessionsToCsv(rows)}`, 'utf8');
  else if (format === 'json') fs.writeFileSync(result.filePath, JSON.stringify(sessionsToCompactJson(rows), null, 2), 'utf8');
  else throw new Error(`不支持的导出格式：${format}`);

  return { canceled: false, filePath: result.filePath };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#090a0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  setApplicationMenu();

  if (isDevServer) {
    await mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    const indexPath = path.join(appRoot, 'dist', 'index.html');
    if (!fs.existsSync(indexPath)) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '启动失败',
        message: '未找到前端页面文件。',
        detail: indexPath
      });
      return;
    }
    await mainWindow.loadFile(indexPath);
  }
}

ipcMain.handle('cases:scan', () => scanCasesFromDisk());

ipcMain.handle('cases:get', (_event, caseId) => {
  if (!caseCache.size) scanCasesFromDisk();
  const found = caseCache.get(caseId);
  if (!found) throw new Error(`未找到病例：${caseId}`);
  return found;
});

ipcMain.handle('dicom:read-files', async (_event, filePaths) => {
  const safePaths = Array.isArray(filePaths) ? filePaths : [];
  return Promise.all(
    safePaths.map(async (filePath) => {
      const buffer = await fs.promises.readFile(filePath);
      return {
        filePath,
        name: path.basename(filePath),
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      };
    })
  );
});

ipcMain.handle('data:import-folder', async () => importDataFolderFromDialog());
ipcMain.handle('sessions:save', (_event, payload) => saveSession(payload));
ipcMain.handle('sessions:list', () => listSessions());
ipcMain.handle('sessions:export', (_event, format) => exportSessions(format));
ipcMain.handle('drafts:save', (_event, payload) => saveDraft(payload));
ipcMain.handle('drafts:get', (_event, caseId) => getDraft(caseId));
ipcMain.handle('drafts:list', () => listDrafts());
ipcMain.handle('drafts:delete', (_event, caseId) => deleteDraft(caseId));

app.whenReady().then(async () => {
  ensureDir(rawRoot);
  await initDatabase();
  scanCasesFromDisk();
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
