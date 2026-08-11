/** Build the consistent title used by the native port-forward prompts. */
export function portForwardStepTitle(step: 1 | 2 | 3): string {
  return `Create Port Forward — Step ${step} of 3`;
}

/** Validate a Transmission Control Protocol port entered in a native input box. */
export function validatePort(
  value: string,
  unavailablePorts: ReadonlySet<number> = new Set()
): string | null {
  if (!value.trim()) {
    return 'Enter a port';
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'Port must be between 1 and 65535';
  }

  if (unavailablePorts.has(port)) {
    return `Local port ${port} is already forwarded`;
  }

  return null;
}

/** Format an error so the action, reason, and recovery stay visible together. */
export function formatErrorMessage(action: string, reason: string, recovery: string): string {
  return `${action} failed: ${reason}. ${recovery}.`;
}
