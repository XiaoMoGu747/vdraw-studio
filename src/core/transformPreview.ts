import type { VDrawDocument, Vec } from '../types/document';
import { expandSelection } from './scene';

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * 拖拽期需要一起做视觉变换的对象：编组后代（`expandSelection`）。
 *
 * 镜像对象**不纳入**：一个 translate/rotate 无法表达反射后的位移与旋转方向，
 * 强行套用会让镜像反向漂移。镜像在抬手时由 `regenerateMirrors` 统一同步，
 * 拖拽期保持静止，视觉偏差比反向漂移更小。
 */
export function previewObjectIds(doc: VDrawDocument, ids: string[]): string[] {
  return expandSelection(doc, ids);
}

export function translatePreviewTransform(dx: number, dy: number): string {
  return `translate(${round(dx)} ${round(dy)})`;
}

export function rotatePreviewTransform(degrees: number, center: Vec): string {
  return `rotate(${round(degrees)} ${round(center.x)} ${round(center.y)})`;
}
