import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const rawRoot = path.join(projectRoot, 'data', 'raw');

function walk(root) {
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

const files = walk(rawRoot);
const dicomFiles = files.filter((file) => {
  const lower = file.toLowerCase();
  return lower.endsWith('.dcm') || lower.endsWith('.dicom') || lower.endsWith('.ima');
});
const jsonFiles = files.filter((file) => file.toLowerCase().endsWith('.json'));
const imageCaseDirs = new Set(
  dicomFiles
    .filter((file) => file.includes(`${path.sep}CT影像${path.sep}`))
    .map((file) => path.basename(path.dirname(file)))
);
const ctReportFiles = jsonFiles.filter((file) => file.includes(`${path.sep}CT报告${path.sep}`) && path.basename(file).match(/^\d+_CT\.json$/));
const supplementalReports = jsonFiles.filter((file) => file.includes(`${path.sep}reports${path.sep}`));

console.log(`rawRoot=${rawRoot}`);
console.log(`dicomFiles=${dicomFiles.length}`);
console.log(`jsonFiles=${jsonFiles.length}`);
console.log(`ctImageCases=${imageCaseDirs.size}`);
console.log(`ctReports=${ctReportFiles.length}`);
console.log(`supplementalReports=${supplementalReports.length}`);

if (imageCaseDirs.size < 80) {
  throw new Error(`Expected at least 80 CT image cases, got ${imageCaseDirs.size}`);
}
if (ctReportFiles.length < 80) {
  throw new Error(`Expected at least 80 CT report JSON files, got ${ctReportFiles.length}`);
}

const missingReports = [...imageCaseDirs].filter((caseId) => !ctReportFiles.some((file) => path.basename(file, '.json') === caseId));
if (missingReports.length) {
  throw new Error(`Missing reports for cases: ${missingReports.join(', ')}`);
}

console.log('data verification passed');
