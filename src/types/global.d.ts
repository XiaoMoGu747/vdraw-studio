export {};

declare global {
  interface VDrawFileResult {
    canceled: boolean;
    path?: string;
    content?: string;
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
      importSvg: () => Promise<VDrawFileResult>;
    };
  }

  interface Window {
    vdraw?: VDrawBridge;
  }
}
