import { useEffect, useState } from 'react';
import { useAppStore } from './store/useAppStore';
import { StartPage } from './components/start/StartPage';
import { EditorView } from './components/editor/EditorView';
import { ImportDialog } from './components/editor/ImportDialog';
import { Toasts } from './components/ui/Toasts';
import { clearAutosave, readAutosave, writeAutosave } from './core/io/autosave';
import type { VDrawDocument } from './types/document';

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/** 自动恢复点：只在文档引用变化时重写，失败只提示一次，避免每 15 秒刷屏。 */
let lastAutosavedDoc: unknown = null;
let autosaveWarned = false;

function autosave(doc: VDrawDocument): void {
  if (lastAutosavedDoc === doc) return;
  const store = useAppStore.getState();
  const ok = writeAutosave(doc);
  lastAutosavedDoc = doc;
  if (!ok && !autosaveWarned) {
    autosaveWarned = true;
    store.notify('自动恢复点写入失败（存储已满或文档过大），请用 Ctrl+S 保存', 'warn');
  }
}

/** “跟随系统”档：只在 system 时读取系统偏好，其余档位直接用它本身。 */
function useResolvedTheme(theme: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia(SYSTEM_DARK_QUERY).matches
  );
  useEffect(() => {
    if (theme !== 'system') return;
    const query = window.matchMedia(SYSTEM_DARK_QUERY);
    const apply = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(query.matches);
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [theme]);
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}

export default function App() {
  const route = useAppStore((state) => state.route);
  const isDirty = useAppStore((state) => state.isDirty);
  const uiDensity = useAppStore((state) => state.uiDensity);
  const reduceMotion = useAppStore((state) => state.reduceMotion);
  const autoSaveSeconds = useAppStore((state) => state.autoSaveSeconds);
  const showToolLabels = useAppStore((state) => state.showToolLabels);
  const theme = useAppStore((state) => state.theme);
  const resolvedTheme = useResolvedTheme(theme);

  // 外观偏好直接挂到根节点，CSS 变量和动效规则无需逐组件传参。
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = uiDensity;
    root.dataset.reduceMotion = reduceMotion ? 'true' : 'false';
    root.dataset.railLabels = showToolLabels ? 'true' : 'false';
    root.dataset.theme = resolvedTheme;
    root.dataset.themeMode = theme;
  }, [uiDensity, reduceMotion, showToolLabels, theme, resolvedTheme]);

  // 启动时优先询问是否恢复上次异常退出/刷新前的编辑。
  useEffect(() => {
    if (window.vdraw?.isSmoke) {
      clearAutosave();
      return;
    }
    const saved = readAutosave();
    if (!saved) return;
    const when = new Date(saved.savedAt).toLocaleString();
    const restore = window.confirm(
      `检测到 ${when} 的自动恢复点（${saved.doc.name || '未命名文档'}）。\n是否恢复这次未保存的编辑？`
    );
    if (!restore) {
      clearAutosave();
      return;
    }
    const store = useAppStore.getState();
    store.loadDocument(saved.doc, saved.doc.filePath ?? '', true);
    autosave(saved.doc);
    store.notify('已恢复自动保存的文档，请另存为正式文件', 'success');
  }, []);

  // 定期写入本地恢复点；页面隐藏/卸载时再补一次，降低崩溃丢失窗口。
  useEffect(() => {
    const flush = () => {
      if (window.vdraw?.isSmoke) return;
      const store = useAppStore.getState();
      if (store.route === 'editor' && store.isDirty) autosave(store.doc);
    };
    const timer =
      autoSaveSeconds > 0 ? window.setInterval(flush, autoSaveSeconds * 1000) : null;
    window.addEventListener('pagehide', flush);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener('pagehide', flush);
    };
  }, [autoSaveSeconds]);

  // 保存成功或新建/打开后，旧恢复点立即失效。
  useEffect(() => {
    if (route === 'editor' && !isDirty) clearAutosave();
  }, [route, isDirty]);

  useEffect(() => {
    const bridge = window.vdraw;
    if (!bridge) {
      // 浏览器开发模式下没有主进程关闭握手，退回原生 beforeunload。
      const handler = (event: BeforeUnloadEvent) => {
        const store = useAppStore.getState();
        if (!store.isDirty) return;
        autosave(store.doc);
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', handler);
      return () => window.removeEventListener('beforeunload', handler);
    }
    return bridge.app.onCloseRequest(() => {
      const store = useAppStore.getState();
      const shouldClose =
        !store.isDirty ||
        window.confirm('当前文档有未保存的修改，关闭后这些修改会丢失。确定要关闭吗？');
      if (shouldClose && store.isDirty) clearAutosave();
      void bridge.app.respondClose(shouldClose);
    });
  }, []);

  return (
    <>
      {route === 'start' ? <StartPage /> : <EditorView />}
      <ImportDialog />
      <Toasts />
    </>
  );
}