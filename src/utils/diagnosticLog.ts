// src/utils/diagnosticLog.ts
//
// Single-channel diagnostic logger for SSH Lite. Two log levels:
//   - infoLog:  always emits. Use for low-volume lifecycle events
//               (connect/disconnect, semaphore destroy, auth method chosen).
//   - diagLog:  gated on `sshLite.diagnosticLogging` setting. Use for
//               high-volume per-operation traces (every acquire/release,
//               every exec attempt, every retry).
//
// The output channel is plumbed in from extension.ts during activation so
// services don't need to import from extension.ts (which would create a cycle).

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;
let diagEnabled = false;

export function setDiagOutputChannel(ch: vscode.OutputChannel): void {
  channel = ch;
  refreshDiagEnabled();
}

export function refreshDiagEnabled(): void {
  try {
    diagEnabled = vscode.workspace
      .getConfiguration('sshLite')
      .get<boolean>('diagnosticLogging', false);
  } catch {
    diagEnabled = false;
  }
}

export function isDiagEnabled(): boolean {
  return diagEnabled;
}

function fmtData(data?: Record<string, unknown>): string {
  if (!data) return '';
  const parts: string[] = [];
  for (const k of Object.keys(data)) {
    const v = data[k];
    let s: string;
    if (v === undefined || v === null) s = String(v);
    else if (typeof v === 'string') s = v.length > 200 ? v.slice(0, 200) + '…' : v;
    else if (typeof v === 'object') {
      try { s = JSON.stringify(v); } catch { s = '[unserializable]'; }
      if (s.length > 200) s = s.slice(0, 200) + '…';
    } else s = String(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length ? '  ' + parts.join(' ') : '';
}

function emit(prefix: string, category: string, message: string, data?: Record<string, unknown>): void {
  if (!channel) return;
  const ts = new Date().toISOString();
  channel.appendLine(`[${ts}] [${prefix}/${category}] ${message}${fmtData(data)}`);
}

export function infoLog(category: string, message: string, data?: Record<string, unknown>): void {
  emit('INFO', category, message, data);
}

export function diagLog(category: string, message: string, data?: Record<string, unknown>): void {
  if (!diagEnabled) return;
  emit('DIAG', category, message, data);
}
