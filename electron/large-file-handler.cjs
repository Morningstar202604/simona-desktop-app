/**
 * Large file handler — smart chunking, search, and analysis
 * Core logic ported from large-file-mcp (MIT license)
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FileType = {
  TEXT: 'text', CODE: 'code', LOG: 'log', CSV: 'csv',
  JSON: 'json', XML: 'xml', MARKDOWN: 'markdown', BINARY: 'binary', UNKNOWN: 'unknown'
};

const FILE_TYPE_MAP = {
  '.txt': FileType.TEXT, '.log': FileType.LOG, '.csv': FileType.CSV,
  '.json': FileType.JSON, '.xml': FileType.XML, '.md': FileType.MARKDOWN,
  '.ts': FileType.CODE, '.js': FileType.CODE, '.jsx': FileType.CODE,
  '.tsx': FileType.CODE, '.py': FileType.CODE, '.java': FileType.CODE,
  '.cpp': FileType.CODE, '.c': FileType.CODE, '.h': FileType.CODE,
  '.go': FileType.CODE, '.rs': FileType.CODE, '.rb': FileType.CODE,
  '.php': FileType.CODE, '.swift': FileType.CODE, '.kt': FileType.CODE,
  '.scala': FileType.CODE, '.sh': FileType.CODE, '.bash': FileType.CODE,
  '.yml': FileType.CODE, '.yaml': FileType.CODE, '.css': FileType.CODE,
  '.scss': FileType.CODE, '.less': FileType.CODE, '.html': FileType.CODE,
  '.vue': FileType.CODE, '.svelte': FileType.CODE,
};

const CHUNK_SIZES = {
  [FileType.LOG]: 500, [FileType.CSV]: 1000, [FileType.JSON]: 100,
  [FileType.CODE]: 300, [FileType.TEXT]: 500, [FileType.MARKDOWN]: 200,
  [FileType.XML]: 200, [FileType.BINARY]: 1000, [FileType.UNKNOWN]: 500,
};

function detectFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return FILE_TYPE_MAP[ext] || FileType.UNKNOWN;
}

function getOptimalChunkSize(fileType, totalLines) {
  const base = CHUNK_SIZES[fileType] || 500;
  return totalLines > 100000 ? Math.min(base * 2, 2000) : base;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes, i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(2)} ${units[i]}`;
}

async function countLines(filePath) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', () => count++);
    rl.on('close', () => resolve(count));
    rl.on('error', reject);
  });
}

async function getMetadata(filePath) {
  const stats = fs.statSync(filePath);
  const fileType = detectFileType(filePath);
  const totalLines = await countLines(filePath);
  return {
    path: filePath, sizeBytes: stats.size,
    sizeFormatted: formatBytes(stats.size), totalLines,
    fileType, createdAt: stats.birthtime, modifiedAt: stats.mtime,
  };
}

async function readLines(filePath, startLine, endLine) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let currentLine = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', line => {
      currentLine++;
      if (currentLine >= startLine && currentLine <= endLine) lines.push(line);
      if (currentLine > endLine) rl.close();
    });
    rl.on('close', () => resolve(lines));
    rl.on('error', reject);
  });
}

async function readChunk(filePath, chunkIndex, options = {}) {
  const meta = await getMetadata(filePath);
  const linesPerChunk = options.linesPerChunk || getOptimalChunkSize(meta.fileType, meta.totalLines);
  const overlap = options.overlapLines || 10;
  const startLine = Math.max(1, chunkIndex * linesPerChunk - overlap + 1);
  const endLine = Math.min(meta.totalLines, (chunkIndex + 1) * linesPerChunk);
  const lines = await readLines(filePath, startLine, endLine);
  const content = options.includeLineNumbers
    ? lines.map((l, i) => `${startLine + i}: ${l}`).join('\n')
    : lines.join('\n');
  return {
    content, startLine, endLine,
    totalLines: meta.totalLines, chunkIndex,
    totalChunks: Math.ceil(meta.totalLines / linesPerChunk),
    filePath, byteSize: Buffer.byteLength(content, 'utf-8'),
  };
}

async function navigateToLine(filePath, lineNumber, contextLines = 5) {
  const meta = await getMetadata(filePath);
  if (lineNumber < 1 || lineNumber > meta.totalLines) {
    throw new Error(`Line ${lineNumber} out of range (1-${meta.totalLines})`);
  }
  const startLine = Math.max(1, lineNumber - contextLines);
  const endLine = Math.min(meta.totalLines, lineNumber + contextLines);
  const lines = await readLines(filePath, startLine, endLine);
  const content = lines.map((line, idx) => {
    const num = startLine + idx;
    return `${num === lineNumber ? '→' : ' '} ${num}: ${line}`;
  }).join('\n');
  return {
    content, startLine, endLine, totalLines: meta.totalLines,
    chunkIndex: Math.floor((lineNumber - 1) / 500),
    totalChunks: Math.ceil(meta.totalLines / 500),
    filePath, byteSize: Buffer.byteLength(content, 'utf-8'),
  };
}

async function searchInFile(filePath, pattern, options = {}) {
  const results = [];
  const maxResults = options.maxResults || 100;
  const ctxBefore = options.contextBefore || 2;
  const ctxAfter = options.contextAfter || 2;
  const regex = options.regex
    ? new RegExp(pattern, options.caseSensitive ? 'g' : 'gi')
    : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive ? 'g' : 'gi');

  return new Promise((resolve, reject) => {
    let lineNumber = 0;
    const lineBuffer = [];
    const pendingCtx = [];
    let maxReached = false;

    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', line => {
      lineNumber++;
      lineBuffer.push(line);
      if (lineBuffer.length > ctxBefore + ctxAfter + 1) lineBuffer.shift();
      if (options.startLine && lineNumber < options.startLine) return;
      if (options.endLine && lineNumber > options.endLine) { rl.close(); return; }

      for (let i = pendingCtx.length - 1; i >= 0; i--) {
        pendingCtx[i].contextAfter.push(line);
        if (pendingCtx[i].contextAfter.length >= ctxAfter) pendingCtx.splice(i, 1);
      }

      if (!maxReached) {
        const matches = Array.from(line.matchAll(regex));
        if (matches.length > 0) {
          const matchPositions = matches.map(m => ({ start: m.index, end: m.index + m[0].length }));
          const bufIdx = lineBuffer.length - 1;
          const before = lineBuffer.slice(Math.max(0, bufIdx - ctxBefore), bufIdx);
          const result = { lineNumber, lineContent: line, matchPositions, contextBefore: before, contextAfter: [], chunkIndex: Math.floor((lineNumber - 1) / 500) };
          results.push(result);
          if (ctxAfter > 0) pendingCtx.push(result);
          if (results.length >= maxResults) maxReached = true;
        }
      }
      if (maxReached && pendingCtx.length === 0) rl.close();
    });
    rl.on('close', () => resolve(results));
    rl.on('error', reject);
  });
}

async function getStructure(filePath) {
  const meta = await getMetadata(filePath);
  let emptyLines = 0, maxLineLen = 0, totalLineLen = 0, lineCount = 0;
  const sampleStart = [], endBuffer = [];

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', line => {
      lineCount++;
      if (line.trim() === '') emptyLines++;
      maxLineLen = Math.max(maxLineLen, line.length);
      totalLineLen += line.length;
      if (sampleStart.length < 10) sampleStart.push(line);
      endBuffer.push(line);
      if (endBuffer.length > 10) endBuffer.shift();
    });
    rl.on('close', () => {
      const recChunkSize = getOptimalChunkSize(meta.fileType, meta.totalLines);
      resolve({
        metadata: meta,
        lineStats: { total: meta.totalLines, empty: emptyLines, nonEmpty: meta.totalLines - emptyLines, maxLineLength: maxLineLen, avgLineLength: lineCount > 0 ? Math.round(totalLineLen / lineCount) : 0 },
        recommendedChunkSize: recChunkSize,
        estimatedChunks: Math.ceil(meta.totalLines / recChunkSize),
        sampleStart, sampleEnd: endBuffer,
      });
    });
    rl.on('error', reject);
  });
}

const SMALL_FILE_LIMIT = 200; // lines — files smaller than this are returned in full

module.exports = {
  FileType, getMetadata, readChunk, readLines, navigateToLine,
  searchInFile, getStructure, getOptimalChunkSize, SMALL_FILE_LIMIT,
};
