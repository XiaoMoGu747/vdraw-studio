import type { VDrawDocument } from '../../types/document';

const AUTOSAVE_KEY = 'vdraw.autosave.v1';

export interface AutosaveRecord {
  savedAt: string;
  doc: VDrawDocument;
}

/**
 * 渲染进程本地恢复点。只保存文档快照，不参与文件格式/版本管理，
 * 因此刷新或异常退出后仍可找回最近一次未保存的编辑。
 */
export function writeAutosave(doc: VDrawDocument): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const record: AutosaveRecord = { savedAt: new Date().toISOString(), doc };
    const payload = JSON.stringify(record);
    // 超过 ~4.5MB 时 localStorage 大概率拒绝写入，提前返回失败让调用方提示用户，
    // 而不是静默地一直"看起来有恢复点"。
    if (payload.length > 4_500_000) return false;
    window.localStorage.setItem(AUTOSAVE_KEY, payload);
    return true;
  } catch {
    // localStorage 可能被禁用或达到配额；失败由调用方提示，不阻断编辑。
    return false;
  }
}

export function readAutosave(): AutosaveRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AutosaveRecord>;
    if (!parsed?.doc || typeof parsed.doc !== 'object') return null;
    if (!parsed.savedAt) return null;
    if (!parsed.doc.page || !Array.isArray(parsed.doc.layers)) return null;
    return { savedAt: parsed.savedAt, doc: parsed.doc as VDrawDocument };
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // 忽略存储不可用的情况。
  }
}