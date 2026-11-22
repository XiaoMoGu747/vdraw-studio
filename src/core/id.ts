let counter = 0;
let nodeCounter = 0;
// 会话前缀：避免跨会话的计数器起点重复，同时不依赖昂贵的 randomUUID。
const sessionPrefix = Math.random().toString(36).slice(2, 6);

/** 生成带前缀的本地唯一 ID。优先使用 crypto.randomUUID，回退到时间戳计数。 */
export function createId(prefix = 'obj'): string {
  counter += 1;
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${random}${counter.toString(36)}`;
}

/**
 * 节点级 ID：一个长笔迹可能包含上千个节点，逐点调用 randomUUID 会在抬笔时
 * 产生明显尖峰。节点 ID 只需在当前文档内唯一，用会话前缀 + 自增计数即可。
 */
export function createNodeId(): string {
  nodeCounter += 1;
  return `node_${sessionPrefix}${nodeCounter.toString(36)}`;
}
