export {};

declare global {
  interface VDrawImportEntry {
    name: string;
    path?: string;
    /** 文本格式内容（.vdraw / .json / .svg）。 */
    content?: string;
    /** 位图 data URL（PNG / JPEG / WebP / GIF / BMP）。 */
    dataUrl?: string;
    /** 原始文件字节数。 */
    bytes?: number;
    /** 单文件读取失败原因；该条目仍会返回，由渲染进程逐条提示。 */
    error?: string;
  }

  interface VDrawFileResult {
    canceled: boolean;
    /** 批量导入结果：每个文件一条，失败项带 error。 */
    files?: VDrawImportEntry[];
    path?: string;
    name?: string;
    content?: string;
    dataUrl?: string;
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
      /** 统一导入：原生对话框可多选工程 / SVG / 位图，逐文件返回内容。 */
      pickImportFiles: () => Promise<VDrawFileResult>;
      /** 兼容旧版仅导入 SVG 的入口。 */
      importSvg: () => Promise<VDrawFileResult>;
    };
  }

  interface Window {
    vdraw?: VDrawBridge;
  }
}
