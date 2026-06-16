import { expandAllInViews, expandFirstLevelInViews, ExpandableTreeView } from './treeExpand';

function makeView(topItems: unknown[] | Error) {
  const reveal = jest.fn().mockResolvedValue(undefined);
  const getChildren = jest.fn().mockImplementation(() => {
    if (topItems instanceof Error) { throw topItems; }
    return topItems;
  });
  return { reveal, getChildren, view: { reveal } as any };
}

describe('expandAllInViews (issue #16)', () => {
  it('uses the native list.expandRecursively when available', async () => {
    const exec = jest.fn().mockResolvedValue(undefined);
    const v = makeView(['a']);
    const views: ExpandableTreeView[] = [{ view: v.view, provider: { getChildren: v.getChildren } }];

    await expandAllInViews(exec, views);

    expect(exec).toHaveBeenCalledWith('list.expandRecursively');
    // Native path succeeded → no manual reveal fallback.
    expect(v.reveal).not.toHaveBeenCalled();
  });

  it('falls back to first-level expand when the command is not found (VS Code < 1.94)', async () => {
    const exec = jest.fn().mockRejectedValue(new Error("command 'list.expandRecursively' not found"));
    const v = makeView(['top1', 'top2']);
    const views: ExpandableTreeView[] = [{ view: v.view, provider: { getChildren: v.getChildren } }];

    await expandAllInViews(exec, views);

    expect(v.getChildren).toHaveBeenCalled();
    expect(v.reveal).toHaveBeenCalledTimes(2);
    expect(v.reveal).toHaveBeenCalledWith('top1', { expand: 1, select: false, focus: false });
  });

  it('never throws even if the fallback provider also fails', async () => {
    const exec = jest.fn().mockRejectedValue(new Error('not found'));
    const v = makeView(new Error('provider boom'));
    const views: ExpandableTreeView[] = [{ view: v.view, provider: { getChildren: v.getChildren } }];

    await expect(expandAllInViews(exec, views)).resolves.toBeUndefined();
  });

  it('does NOT fall back on a non-"not found" error (avoids double-expand on 1.94+)', async () => {
    const exec = jest.fn().mockRejectedValue(new Error('tree provider blew up mid-walk'));
    const v = makeView(['top1']);
    const views: ExpandableTreeView[] = [{ view: v.view, provider: { getChildren: v.getChildren } }];

    await expect(expandAllInViews(exec, views)).resolves.toBeUndefined();
    expect(v.reveal).not.toHaveBeenCalled();
  });
});

describe('expandFirstLevelInViews', () => {
  it('reveals every top-level item one level deep', async () => {
    const v = makeView(['x', 'y']);
    await expandFirstLevelInViews([{ view: v.view, provider: { getChildren: v.getChildren } }]);
    expect(v.reveal).toHaveBeenCalledTimes(2);
  });

  it('skips views that failed to register (undefined view)', async () => {
    const getChildren = jest.fn().mockResolvedValue(['x']);
    await expect(
      expandFirstLevelInViews([{ view: undefined, provider: { getChildren } }])
    ).resolves.toBeUndefined();
    // getChildren is only reached after the view-presence check.
    expect(getChildren).not.toHaveBeenCalled();
  });

  it('ignores an unrevealable item without aborting the rest', async () => {
    const reveal = jest
      .fn()
      .mockRejectedValueOnce(new Error('not revealable'))
      .mockResolvedValueOnce(undefined);
    const getChildren = jest.fn().mockResolvedValue(['bad', 'good']);
    await expandFirstLevelInViews([{ view: { reveal } as any, provider: { getChildren } }]);
    expect(reveal).toHaveBeenCalledTimes(2);
  });
});
