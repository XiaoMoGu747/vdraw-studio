import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { TemplateId } from '../../core/document';
import { chemScopeIds, validateStructure } from '../../core/chemistry/valence';
import { cleanupStructure } from '../../core/chemistry/cleanup';
import { exportMol, exportSmiles } from '../../core/io/chemExport';
import { downloadExportedFile } from '../../core/io/browserExport';
import { Icon } from '../ui/Icon';
import { useFileActions } from './useFileActions';

interface MenuItemDef {
  id: string;
  label: string;
  shortcut?: string;
  onSelect?: () => void;
  disabled?: boolean;
  checked?: boolean;
  separatorAfter?: boolean;
}

interface MenuDef {
  id: string;
  label: string;
  items: MenuItemDef[];
}

function MenuItem({ item, onClose }: { item: MenuItemDef; onClose: () => void }) {
  const disabled = item.disabled || !item.onSelect;
  return (
    <button
      type="button"
      className={`menu-item${disabled ? ' is-disabled' : ''}`}
      disabled={disabled}
      onClick={() => {
        item.onSelect?.();
        onClose();
      }}
    >
      <span className="menu-item__check">
        {item.checked ? <Icon name="check" size={13} strokeWidth={2} /> : null}
      </span>
      <span className="menu-item__label">{item.label}</span>
      {item.shortcut ? <span className="menu-item__shortcut">{item.shortcut}</span> : null}
    </button>
  );
}

export function MenuBar() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileActions = useFileActions();

  const doc = useAppStore((state) => state.doc);
  const past = useAppStore((state) => state.past);
  const future = useAppStore((state) => state.future);
  const selection = useAppStore((state) => state.selection);
  const clipboard = useAppStore((state) => state.clipboard);
  const showGrid = useAppStore((state) => state.showGrid);
  const showRulers = useAppStore((state) => state.showRulers);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const viewportSize = useAppStore((state) => state.viewportSize);

  const startDocument = useAppStore((state) => state.startDocument);
  const goToStart = useAppStore((state) => state.goToStart);
  const notify = useAppStore((state) => state.notify);
  const undo = useAppStore((state) => state.undo);
  const redo = useAppStore((state) => state.redo);
  const zoomAt = useAppStore((state) => state.zoomAt);
  const setZoom = useAppStore((state) => state.setZoom);
  const fitToCanvas = useAppStore((state) => state.fitToCanvas);
  const toggleGrid = useAppStore((state) => state.toggleGrid);
  const toggleRulers = useAppStore((state) => state.toggleRulers);
  const toggleSnap = useAppStore((state) => state.toggleSnap);
  const setTool = useAppStore((state) => state.setTool);
  const selectAll = useAppStore((state) => state.selectAll);
  const copySelection = useAppStore((state) => state.copySelection);
  const pasteClipboard = useAppStore((state) => state.pasteClipboard);
  const duplicateSelection = useAppStore((state) => state.duplicateSelection);
  const deleteSelection = useAppStore((state) => state.deleteSelection);
  const groupSelection = useAppStore((state) => state.groupSelection);
  const ungroupSelection = useAppStore((state) => state.ungroupSelection);
  const alignSelection = useAppStore((state) => state.alignSelection);
  const distributeSelection = useAppStore((state) => state.distributeSelection);
  const reorderSelection = useAppStore((state) => state.reorderSelection);
  const updateDoc = useAppStore((state) => state.updateDoc);
  const setChemReport = useAppStore((state) => state.setChemReport);
  const exportTransparent = useAppStore((state) => state.exportTransparent);
  const toggleExportTransparent = useAppStore((state) => state.toggleExportTransparent);
  const openExportPanel = useAppStore((state) => state.openExportPanel);
  const openSettings = useAppStore((state) => state.openSettings);

  const centerAnchor = { x: viewportSize.width / 2, y: viewportSize.height / 2 };
  const hasSelection = selection.length > 0;
  const hasGroup = selection.some(
    (id) => useAppStore.getState().doc.layers.some((layer) => layer.objects.some((obj) => obj.id === id && obj.type === 'group'))
  );

  useEffect(() => {
    if (!openMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpenMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenu]);

  const runCheck = () => {
    const state = useAppStore.getState();
    const issues = validateStructure(state.doc, chemScopeIds(state.doc, selection));
    setChemReport({
      title: '基础化合价校验',
      issues,
      emptyMessage: '未发现超价原子；化学键与显式标签处于常见价态范围内。'
    });
    setTool('select');
  };

  /** 结构互操作：MOL（V2000）与 SMILES 导出，桌面端原生保存、网页端下载。 */
  const exportChemFile = async (kind: 'mol' | 'smiles') => {
    const state = useAppStore.getState();
    const data = kind === 'mol' ? exportMol(state.doc, state.doc.name) : exportSmiles(state.doc);
    if (!data.trim()) {
      notify('当前文档没有可导出的化学结构', 'warn');
      return;
    }
    const extension = kind === 'mol' ? 'mol' : 'smi';
    const fileName = `${state.doc.name || 'vdraw-chem'}.${extension}`;
    try {
      const api = window.vdraw;
      if (api) {
        const result = await api.file.exportFile({
          data,
          encoding: 'utf8',
          defaultName: fileName,
          filters: [
            {
              name: kind === 'mol' ? 'MDL MOL' : 'SMILES',
              extensions: [extension]
            }
          ]
        });
        if (result.canceled || !result.path) return;
        notify(`已导出：${result.path}`, 'success');
        return;
      }
      downloadExportedFile({
        fileName,
        mimeType: kind === 'mol' ? 'chemical/x-mdl-molfile' : 'chemical/x-daylight-smiles',
        data,
        encoding: 'utf8'
      });
      notify(`已下载：${fileName}`, 'success');
    } catch (error) {
      notify(
        error instanceof Error ? `导出失败：${error.message}` : '导出失败',
        'warn'
      );
    }
  };

  const runCleanup = () => {
    const state = useAppStore.getState();
    const result = cleanupStructure(state.doc, state.selection);
    if (result.moved === 0) {
      notify('当前没有可整理的化学结构', 'warn');
      return;
    }
    updateDoc(result.doc, true);
    notify(`已整理 ${result.moved} 个结构节点`, 'success');
  };

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: '文件',
      items: [
        { id: 'new', label: '新建文档', shortcut: 'Ctrl+N', onSelect: () => startDocument(doc.templateId as TemplateId) },
        { id: 'open', label: '打开…', shortcut: 'Ctrl+O', onSelect: () => void fileActions.open() },
        { id: 'save', label: '保存', shortcut: 'Ctrl+S', onSelect: () => void fileActions.save() },
        { id: 'save-as', label: '另存为…', shortcut: 'Ctrl+Shift+S', onSelect: () => void fileActions.save(true), separatorAfter: false },
        { id: 'open-save-dir', label: '打开保存文件夹', onSelect: () => void fileActions.openSaveDir(), separatorAfter: true },
        { id: 'import-svg', label: '导入 SVG…', onSelect: () => void fileActions.importSvg() },
        {
          id: 'export-transparent',
          label: '无背景导出（PNG / SVG）',
          checked: exportTransparent,
          onSelect: toggleExportTransparent
        },
        { id: 'export-panel', label: '导出…', shortcut: 'Ctrl+E', onSelect: () => openExportPanel() },
        { id: 'export-svg', label: '导出 SVG…', onSelect: () => void fileActions.exportAs('svg') },
        { id: 'export-png', label: '导出 PNG…', onSelect: () => void fileActions.exportAs('png') },
        { id: 'export-jpg', label: '导出 JPG…', onSelect: () => void fileActions.exportAs('jpg') },
        { id: 'export-pdf', label: '导出 PDF…', onSelect: () => void fileActions.exportAs('pdf') },
        {
          id: 'export-region',
          label: '导出框选区域…',
          onSelect: () => openExportPanel(undefined, 'region')
        },
        {
          id: 'export-selection',
          label: '导出选中对象…',
          disabled: !hasSelection,
          onSelect: () => openExportPanel(undefined, 'selection'),
          separatorAfter: true
        },
        { id: 'templates', label: '返回启动页 / 模板', onSelect: goToStart }
      ]
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        { id: 'undo', label: '撤销', shortcut: 'Ctrl+Z', onSelect: undo, disabled: past.length === 0 },
        { id: 'redo', label: '重做', shortcut: 'Ctrl+Shift+Z', onSelect: redo, disabled: future.length === 0 },
        { id: 'sep-1', label: '', separatorAfter: false },
        { id: 'copy', label: '复制', shortcut: 'Ctrl+C', onSelect: copySelection, disabled: !hasSelection },
        { id: 'paste', label: '粘贴', shortcut: 'Ctrl+V', onSelect: pasteClipboard, disabled: !clipboard || clipboard.length === 0 },
        { id: 'duplicate', label: '创建副本', shortcut: 'Ctrl+D', onSelect: duplicateSelection, disabled: !hasSelection, separatorAfter: true },
        { id: 'delete', label: '删除所选', shortcut: 'Delete', onSelect: deleteSelection, disabled: !hasSelection },
        { id: 'select-all', label: '全选', shortcut: 'Ctrl+A', onSelect: selectAll, separatorAfter: true },
        { id: 'group', label: '编组', shortcut: 'Ctrl+G', onSelect: groupSelection, disabled: selection.length < 2 },
        { id: 'ungroup', label: '取消编组', shortcut: 'Ctrl+Shift+G', onSelect: ungroupSelection, disabled: !hasGroup }
      ]
    },
    {
      id: 'object',
      label: '对象',
      items: [
        { id: 'front', label: '置于顶层', onSelect: () => reorderSelection('front'), disabled: !hasSelection },
        { id: 'back', label: '置于底层', onSelect: () => reorderSelection('back'), disabled: !hasSelection, separatorAfter: true },
        { id: 'align-left', label: '左对齐', onSelect: () => alignSelection('left'), disabled: !hasSelection },
        { id: 'align-center-h', label: '水平居中', onSelect: () => alignSelection('center-h'), disabled: !hasSelection },
        { id: 'align-right', label: '右对齐', onSelect: () => alignSelection('right'), disabled: !hasSelection },
        { id: 'align-top', label: '顶对齐', onSelect: () => alignSelection('top'), disabled: !hasSelection },
        { id: 'align-center-v', label: '垂直居中', onSelect: () => alignSelection('center-v'), disabled: !hasSelection },
        { id: 'align-bottom', label: '底对齐', onSelect: () => alignSelection('bottom'), disabled: !hasSelection, separatorAfter: true },
        { id: 'distribute-h', label: '水平分布', onSelect: () => distributeSelection('h'), disabled: selection.length < 3 },
        { id: 'distribute-v', label: '垂直分布', onSelect: () => distributeSelection('v'), disabled: selection.length < 3 }
      ]
    },
    {
      id: 'view',
      label: '视图',
      items: [
        { id: 'zoom-in', label: '放大', shortcut: 'Ctrl+=', onSelect: () => zoomAt(1.2, centerAnchor) },
        { id: 'zoom-out', label: '缩小', shortcut: 'Ctrl+-', onSelect: () => zoomAt(1 / 1.2, centerAnchor) },
        { id: 'zoom-100', label: '实际大小', shortcut: 'Ctrl+0', onSelect: () => setZoom(1, centerAnchor) },
        { id: 'zoom-fit', label: '适应窗口', shortcut: 'Ctrl+1', onSelect: () => fitToCanvas() },
        {
          id: 'zoom-selection',
          label: '缩放到选中对象',
          shortcut: 'Ctrl+2',
          disabled: !hasSelection,
          onSelect: () => useAppStore.getState().zoomToSelection(),
          separatorAfter: true
        },
        { id: 'grid', label: '显示网格', checked: showGrid, onSelect: toggleGrid },
        { id: 'rulers', label: '显示标尺', checked: showRulers, onSelect: toggleRulers },
        { id: 'snap', label: '吸附对齐', checked: snapEnabled, onSelect: toggleSnap, separatorAfter: true },
        { id: 'settings', label: '设置…', onSelect: openSettings }
      ]
    },
    {
      id: 'chemistry',
      label: '化学',
      items: [
        { id: 'valence', label: '化合价校验…', onSelect: runCheck },
        { id: 'cleanup', label: '结构自动整理', onSelect: runCleanup, separatorAfter: true },
        { id: 'export-mol', label: '导出 MOL…', onSelect: () => void exportChemFile('mol') },
        { id: 'export-smiles', label: '导出 SMILES…', onSelect: () => void exportChemFile('smiles') },
        { id: 'chem-sep', label: '', separatorAfter: true },
        { id: 'ring', label: '插入环系', onSelect: () => setTool('ring') },
        { id: 'atom', label: '添加原子标签', onSelect: () => setTool('atom') },
        { id: 'bond', label: '绘制化学键', onSelect: () => setTool('bond') },
        { id: 'arrow', label: '反应箭头与机理', onSelect: () => setTool('arrow') }
      ]
    },
    {
      id: 'help',
      label: '帮助',
      items: [
        {
          id: 'shortcuts',
          label: '快捷键一览…',
          onSelect: () => window.dispatchEvent(new Event('vdraw:shortcut-overlay'))
        },
        {
          id: 'command-palette',
          label: '命令面板…',
          shortcut: 'Ctrl+K',
          onSelect: () => window.dispatchEvent(new Event('vdraw:command-palette'))
        },
        {
          id: 'about',
          label: '关于 VDraw Studio',
          onSelect: () => notify('VDraw Studio 0.2.0 · 本地矢量与有机化学绘图')
        }
      ]
    }
  ];

  return (
    <div className="menubar" ref={rootRef}>
      <div className="menubar__menus">
        {menus.map((menu) => (
          <div className="menubar__item" key={menu.id}>
            <button
              type="button"
              className={`menubar__trigger${openMenu === menu.id ? ' is-open' : ''}`}
              onClick={() => setOpenMenu(openMenu === menu.id ? null : menu.id)}
              onPointerEnter={() => {
                if (openMenu) setOpenMenu(menu.id);
              }}
            >
              {menu.label}
            </button>
            {openMenu === menu.id ? (
              <div className="menu-dropdown" role="menu">
                {menu.items.map((item) =>
                  item.separatorAfter && !item.onSelect ? (
                    <div className="menu-sep" key={item.id} />
                  ) : (
                    <div key={item.id}>
                      <MenuItem item={item} onClose={() => setOpenMenu(null)} />
                      {item.separatorAfter ? <div className="menu-sep" /> : null}
                    </div>
                  )
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="menubar__meta">
        <span className="menubar__offline">
          <span className="menubar__offline-dot" />
          {doc.filePath ? '本地文件' : '本地草稿'}
        </span>
        <span className="menubar__phase">离线 · 数据仅在本机</span>
      </div>
    </div>
  );
}
