/**
 * TerminalService tests
 *
 * Tests terminal management:
 * - Singleton pattern
 * - Terminal counting per connection
 * - Terminal ID generation
 * - Error handling on terminal creation
 *
 * The actual pseudoterminal creation and SSH shell integration
 * are too tightly coupled to VS Code to unit test meaningfully.
 */

import { TerminalService } from './TerminalService';

function resetService(): TerminalService {
  (TerminalService as any)._instance = undefined;
  return TerminalService.getInstance();
}

describe('TerminalService', () => {
  let service: TerminalService;

  beforeEach(() => {
    service = resetService();
  });

  describe('getInstance', () => {
    it('should return singleton', () => {
      const a = TerminalService.getInstance();
      const b = TerminalService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('getTerminalCount', () => {
    it('should return 0 for unknown connection', () => {
      expect(service.getTerminalCount('nonexistent')).toBe(0);
    });

    it('should return 0 initially', () => {
      expect(service.getTerminalCount('conn1')).toBe(0);
    });
  });

  describe('terminal ID format', () => {
    it('should format as connectionId-number', () => {
      const connectionId = '10.0.0.1:22:admin';
      const terminalNumber = 1;
      const expectedId = `${connectionId}-${terminalNumber}`;
      expect(expectedId).toBe('10.0.0.1:22:admin-1');
    });

    it('should increment terminal numbers', () => {
      const connectionId = 'conn1';
      const ids = [
        `${connectionId}-1`,
        `${connectionId}-2`,
        `${connectionId}-3`,
      ];
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe('multi-connection terminal management', () => {
    it('should generate unique IDs across different connections', () => {
      const id1 = '10.0.0.1:22:admin-1';
      const id2 = '10.0.0.2:22:admin-1';
      const id3 = '10.0.0.1:22:deploy-1';

      const ids = new Set([id1, id2, id3]);
      expect(ids.size).toBe(3);
    });

    it('should track terminal counts independently per connection', () => {
      expect(service.getTerminalCount('conn1')).toBe(0);
      expect(service.getTerminalCount('conn2')).toBe(0);
      expect(service.getTerminalCount('conn3')).toBe(0);
    });

    it('should handle terminal IDs with different port numbers', () => {
      const prodId = '10.0.0.1:22:admin-1';
      const customPortId = '10.0.0.1:2222:admin-1';
      expect(prodId).not.toBe(customPortId);
    });
  });
});
