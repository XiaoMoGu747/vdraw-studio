export {};

declare global {
  interface VDrawFileResult {
    canceled: boolean;
    path?: string;
    name?: string;
    /** 文本格式内容（.vdraw / .json / .svg）。 */
    content?: string;
    /** 位图 data URL（PNG / JPEG / WebP / GIF / BMP）。 */
    dataUrl?: string;
    /** 原始文件字节数。 */
    bytes?: number;
    directory?: string;
    fallback?: boolean;
    reason?: string;
  }

  interface VDrawBridge {
    platform: string;
    isSmoke: boolean;
    versions: { electron: string; chrome: string; node: string };
    window: {
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<boolean>;
      close: () => Promise<void>;
      onStateChange: (handler: (state: { maximized: boolean }) => void) => () => void;
    };
    app: {
      info: () => Promise<{
        version: string;
        electron: string;
        chrome: string;
        node: string;
        platform: string;
      }>;
      onCloseRequest: (handler: () => void) => () => void;
      respondClose: (shouldClose: boolean) => Promise<boolean>;
    };
    file: {
      openDocument: () => Promise<VDrawFileResult>;
      openPath: (filePath: string) => Promise<VDrawFileResult>;
      saveDocument: (payload: {
        content: string;
        path?: string | null;
        suggestedName?: string;
        forceDialog?: boolean;
      }) => Promise<VDrawFileResult>;
      getSaveDir: () => Promise<{
        directory: string;
        fallback: boolean;
        reason?: string;
      }>;
      openSaveDir: () => Promise<{
        directory: string;
        fallback: boolean;
        reason?: string;
        error?: string | null;
      }>;
      exportFile: (payload: {
        data: string;
        encoding: 'utf8' | 'base64';
        defaultName: string;
        filters?: { name: string; extensions: string[] }[];
      }) => Promise<VDrawFileResult>;
      exportPdf: (payload: {
        svg: string;
        defaultName: string;
        width: number;
        height: number;
      }) => Promise<VDrawFileResult>;
      /** 统一导入：原生对话框选择 .vdraw / .json / .svg 并返回文本内容。 */
      pickImportFile: () => Promise<VDrawFileResult>;
      /** 兼容旧版仅导入 SVG 的入口。 */
      importSvg: () => Promise<VDrawFileResult>;
    };
  }

  interface Window {
    vdraw?: VDrawBridge;
  }
}
