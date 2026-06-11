import * as dicomParser from 'dicom-parser';
import type { DicomFilePayload } from './types';

export type ParsedDicomImage = {
  filePath: string;
  name: string;
  rows: number;
  columns: number;
  pixels: Float32Array;
  min: number;
  max: number;
  windowCenter: number;
  windowWidth: number;
  slope: number;
  intercept: number;
  modality: string;
  patientId: string;
  seriesDescription: string;
  instanceNumber: number;
  pixelSpacing: [number, number] | null;
  photometricInterpretation: string;
};

function numberFromString(value: string | undefined, fallback = 0) {
  if (!value) return fallback;
  const first = value.split('\\')[0].trim();
  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePixelSpacing(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const parts = value.split('\\').map((item) => Number(item));
  if (parts.length < 2 || parts.some((item) => !Number.isFinite(item) || item <= 0)) return null;
  return [parts[0], parts[1]];
}

function getString(dataSet: dicomParser.DataSet, tag: string, fallback = '') {
  try {
    return dataSet.string(tag) || fallback;
  } catch {
    return fallback;
  }
}

function getUint16(dataSet: dicomParser.DataSet, tag: string, fallback = 0) {
  try {
    return dataSet.uint16(tag) ?? fallback;
  } catch {
    return fallback;
  }
}

function getIntString(dataSet: dicomParser.DataSet, tag: string, fallback = 0) {
  return numberFromString(getString(dataSet, tag), fallback);
}

export function parseDicomFile(file: DicomFilePayload): ParsedDicomImage {
  const bytes = new Uint8Array(file.data);
  const dataSet = dicomParser.parseDicom(bytes);
  const rows = getUint16(dataSet, 'x00280010');
  const columns = getUint16(dataSet, 'x00280011');
  const bitsAllocated = getUint16(dataSet, 'x00280100', 16);
  const pixelRepresentation = getUint16(dataSet, 'x00280103', 0);
  const samplesPerPixel = getUint16(dataSet, 'x00280002', 1);
  const slope = numberFromString(getString(dataSet, 'x00281053'), 1);
  const intercept = numberFromString(getString(dataSet, 'x00281052'), 0);
  const photometricInterpretation = getString(dataSet, 'x00280004', 'MONOCHROME2');
  const pixelElement = dataSet.elements.x7fe00010;

  if (!rows || !columns || !pixelElement) {
    throw new Error(`${file.name} 缺少可显示的 PixelData。`);
  }
  if (samplesPerPixel !== 1) {
    throw new Error(`${file.name} 暂只支持单通道灰阶 DICOM。`);
  }
  if (pixelElement.encapsulatedPixelData) {
    throw new Error(`${file.name} 使用了压缩传输语法，首版暂不解码压缩 PixelData。`);
  }

  const total = rows * columns;
  const pixels = new Float32Array(total);
  const view = new DataView(bytes.buffer, bytes.byteOffset + pixelElement.dataOffset, pixelElement.length);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < total; i += 1) {
    let raw = 0;
    if (bitsAllocated === 8) {
      raw = pixelRepresentation ? view.getInt8(i) : view.getUint8(i);
    } else if (bitsAllocated === 16) {
      raw = pixelRepresentation ? view.getInt16(i * 2, true) : view.getUint16(i * 2, true);
    } else {
      throw new Error(`${file.name} 暂不支持 ${bitsAllocated} bit 像素。`);
    }
    const value = raw * slope + intercept;
    pixels[i] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const defaultWidth = Math.max(1, max - min);
  const windowCenter = numberFromString(getString(dataSet, 'x00281050'), min + defaultWidth / 2);
  const windowWidth = numberFromString(getString(dataSet, 'x00281051'), defaultWidth);

  return {
    filePath: file.filePath,
    name: file.name,
    rows,
    columns,
    pixels,
    min,
    max,
    windowCenter,
    windowWidth,
    slope,
    intercept,
    modality: getString(dataSet, 'x00080060', 'DICOM'),
    patientId: getString(dataSet, 'x00100020', ''),
    seriesDescription: getString(dataSet, 'x0008103e', ''),
    instanceNumber: getIntString(dataSet, 'x00200013', 0),
    pixelSpacing: parsePixelSpacing(getString(dataSet, 'x00280030')),
    photometricInterpretation
  };
}

export function parseDicomSeries(files: DicomFilePayload[]) {
  return files
    .map(parseDicomFile)
    .sort((a, b) => {
      if (a.instanceNumber !== b.instanceNumber) return a.instanceNumber - b.instanceNumber;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    });
}
