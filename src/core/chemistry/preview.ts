import type { VDrawDocument, Vec } from '../../types/document';

const ENDPOINT_TOLERANCE = 2.5;

const near = (a: Vec, b: Vec): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) <= ENDPOINT_TOLERANCE;

/**
 * resize 预览期真正需要拿预览文档重算的化学对象：
 * - 被选中的键；
 * - 端点靠近被选中原子的键（原子移动/缩放会改变键的裁剪长度）；
 * - 自身或被选中的子对象命中的环/编组。
 *
 * 其余键/环继续使用原文档，memo 不会因 dragPreview.doc 变化而失效。
 */
export function chemistryPreviewIds(
  doc: VDrawDocument,
  changedIds: Iterable<string>
): Set<string> {
  const changed = new Set(changedIds);
  const changedAtoms: Vec[] = [];
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (const object of layer.objects) {
      if (object.type === 'atom' && changed.has(object.id)) {
        changedAtoms.push(object.position);
      }
    }
  }

  const result = new Set<string>();
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (const object of layer.objects) {
      if (!object.visible) continue;
      if (object.type === 'bond') {
        if (
          changed.has(object.id) ||
          changedAtoms.some(
            (atom) => near(atom, object.start) || near(atom, object.end)
          )
        ) {
          result.add(object.id);
        }
      } else if (object.type === 'group') {
        if (
          changed.has(object.id) ||
          object.childIds.some((childId) => changed.has(childId))
        ) {
          result.add(object.id);
        }
      }
    }
  }
  return result;
}
