import { formatErrorMessage, portForwardStepTitle, validatePort } from './nativeFeedback';

describe('nativeFeedback', () => {
  it.each([
    [1, 'Create Port Forward — Step 1 of 3'],
    [2, 'Create Port Forward — Step 2 of 3'],
    [3, 'Create Port Forward — Step 3 of 3'],
  ] as const)('labels port-forward step %s', (step, title) => {
    expect(portForwardStepTitle(step)).toBe(title);
  });

  it.each([
    ['', 'Enter a port'],
    ['   ', 'Enter a port'],
    ['0', 'Port must be between 1 and 65535'],
    ['65536', 'Port must be between 1 and 65535'],
    ['1.5', 'Port must be between 1 and 65535'],
    ['8080abc', 'Port must be between 1 and 65535'],
  ])('validates port %p', (value, message) => {
    expect(validatePort(value)).toBe(message);
  });

  it.each(['1', '65535', ' 8080 '])('accepts integer port %p', (value) => {
    expect(validatePort(value)).toBeNull();
  });

  it('reports an unavailable local port', () => {
    expect(validatePort('8080', new Set([8080]))).toBe('Local port 8080 is already forwarded');
  });

  it('formats errors with recovery guidance', () => {
    expect(
      formatErrorMessage(
        'Create port forward',
        'Address already in use',
        'Choose another local port and try again'
      )
    ).toBe(
      'Create port forward failed: Address already in use. Choose another local port and try again.'
    );
  });
});
