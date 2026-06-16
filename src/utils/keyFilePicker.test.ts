/**
 * pickPrivateKeyPath — offers a "Browse for key file" (OS dialog) and a
 * "Type the path" choice, plus an optional "No key" choice.
 */

import * as vscode from 'vscode';
import { pickPrivateKeyPath } from './keyFilePicker';

const qp = () => vscode.window.showQuickPick as jest.Mock;
const od = () => vscode.window.showOpenDialog as jest.Mock;
const ib = () => vscode.window.showInputBox as jest.Mock;

// Resolve the QuickPick to the item at the given index (so tests don't depend
// on the exact label/icon strings the implementation uses).
function pickItem(index: number): void {
  qp().mockImplementation((items: vscode.QuickPickItem[]) => Promise.resolve(items[index]));
}

describe('pickPrivateKeyPath', () => {
  beforeEach(() => {
    qp().mockReset();
    od().mockReset().mockResolvedValue(undefined);
    ib().mockReset().mockResolvedValue(undefined);
  });

  it('returns the browsed file path (mouse selection)', async () => {
    pickItem(0); // Browse
    od().mockResolvedValue([{ fsPath: '/home/u/.ssh/id_ed25519' }]);
    expect(await pickPrivateKeyPath({ title: 'Key' })).toBe('/home/u/.ssh/id_ed25519');
    expect(od()).toHaveBeenCalledTimes(1);
  });

  it('returns the typed path (keeps ~ portable)', async () => {
    pickItem(1); // Type
    ib().mockResolvedValue('~/.ssh/id_rsa');
    expect(await pickPrivateKeyPath({ title: 'Key' })).toBe('~/.ssh/id_rsa');
    expect(od()).not.toHaveBeenCalled();
  });

  it('returns "" when the user chooses "No key" (optional only)', async () => {
    pickItem(2); // None (only present when optional)
    expect(await pickPrivateKeyPath({ title: 'Key', optional: true })).toBe('');
  });

  it('offers the "No key" choice only when optional', async () => {
    let captured: vscode.QuickPickItem[] = [];
    qp().mockImplementation((items: vscode.QuickPickItem[]) => {
      captured = items;
      return Promise.resolve(undefined);
    });
    await pickPrivateKeyPath({ title: 'Key' });
    expect(captured).toHaveLength(2); // Browse + Type
    await pickPrivateKeyPath({ title: 'Key', optional: true });
    expect(captured).toHaveLength(3); // Browse + Type + None
  });

  it('offers "Keep current key" as the first item and returns the current path', async () => {
    let captured: vscode.QuickPickItem[] = [];
    qp().mockImplementation((items: vscode.QuickPickItem[]) => {
      captured = items;
      return Promise.resolve(items[0]); // Keep current
    });
    const r = await pickPrivateKeyPath({ title: 'Key', current: '/home/u/.ssh/id_rsa', optional: true });
    expect(r).toBe('/home/u/.ssh/id_rsa');
    expect(captured[0].detail).toBe('/home/u/.ssh/id_rsa'); // first item shows the current path
    expect(captured).toHaveLength(4); // Keep + Browse + Type + None
  });

  it('omits "Keep current key" when no current path is given', async () => {
    let captured: vscode.QuickPickItem[] = [];
    qp().mockImplementation((items: vscode.QuickPickItem[]) => {
      captured = items;
      return Promise.resolve(undefined);
    });
    await pickPrivateKeyPath({ title: 'Key', optional: true });
    expect(captured).toHaveLength(3); // Browse + Type + None (no Keep)
  });

  it('returns undefined when the picker is cancelled', async () => {
    qp().mockResolvedValue(undefined);
    expect(await pickPrivateKeyPath({ title: 'Key' })).toBeUndefined();
  });

  it('returns undefined when the file dialog is cancelled', async () => {
    pickItem(0); // Browse
    od().mockResolvedValue(undefined);
    expect(await pickPrivateKeyPath({ title: 'Key' })).toBeUndefined();
  });

  it('returns undefined when the type-the-path box is cancelled', async () => {
    pickItem(1); // Type
    ib().mockResolvedValue(undefined);
    expect(await pickPrivateKeyPath({ title: 'Key' })).toBeUndefined();
  });

  it('pre-fills the type box with initialPath', async () => {
    pickItem(1); // Type
    ib().mockResolvedValue('/keep/this');
    await pickPrivateKeyPath({ title: 'Key', initialPath: '/keep/this' });
    expect(ib()).toHaveBeenCalledWith(expect.objectContaining({ value: '/keep/this' }));
  });
});
