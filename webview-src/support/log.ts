// webview-src/support/log.ts
//
// Webview-side logger. Cannot write to the extension's Output channel
// directly, so it posts {type:'log', level, scope, event, payload} messages
// back to the extension which forwards via infoLog/diagLog.
//
// Levels match the extension-side diagnosticLog module:
//   - info: always emits.
//   - diag: gated by sshLite.diagnosticLogging on the extension side.

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };

let api: { postMessage: (msg: unknown) => void } | null = null;

function getApi(): { postMessage: (msg: unknown) => void } {
  if (!api) {
    api = acquireVsCodeApi();
  }
  return api;
}

type LogPayload = Record<string, unknown> | undefined;

function emit(level: 'info' | 'diag', scope: string, event: string, payload?: LogPayload): void {
  try {
    getApi().postMessage({ type: 'log', level, scope, event, payload });
  } catch {
    // postMessage failure is silent — never throw from the logger.
  }
}

export function info(scope: string, event: string, payload?: LogPayload): void {
  emit('info', scope, event, payload);
}

export function diag(scope: string, event: string, payload?: LogPayload): void {
  emit('diag', scope, event, payload);
}

export function getVsCodeApi(): { postMessage: (msg: unknown) => void } {
  return getApi();
}
