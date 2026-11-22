import { useEffect, useRef, useState } from 'react';
import { TEMPLATES, type TemplateId } from '../../core/document';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';

interface NewCanvasDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 用途预置：只影响画布类型、命名与网格，不改动键长/默认尺寸等印刷参数。 */
const USE_CASES: {
  id: string;
  title: string;
  desc: string;
  name: string;
  templateId: TemplateId;
  gridSize: number;
  showGrid: boolean;
}[] = [
  {
    id: 'reaction',
    title: '反应式排版',
    desc: '化学图层 · A4 横版',
    name: '反应式',
    templateId: 'chem-sheet',
    gridSize: 10,
    showGrid: true
  },
  {
    id: 'molecule',
    title: '分子结构',
    desc: '化学图层 · 单分子',
    name: '分子结构',
    templateId: 'chem-sheet',
    gridSize: 10,
    showGrid: false
  },
  {
    id: 'paper',
    title: '论文插图',
    desc: 'A4 竖版 · 矢量导出',
    name: '论文插图',
    templateId: 'a4-portrait',
    gridSize: 20,
    showGrid: false
  }
];

/** 新建画布配置面板：名称、尺寸、模板与无限画布。 */
export function NewCanvasDialog({ open, onClose }: NewCanvasDialogProps) {
  const startDocumentWith = useAppStore((state) => state.startDocumentWith);
  const customTemplates = useAppStore((state) => state.customTemplates);
  const addCanvasPreset = useAppStore((state) => state.addCanvasPreset);
  const removeCanvasPreset = useAppStore((state) => state.removeCanvasPreset);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<TemplateId>('blank-landscape');
  const [width, setWidth] = useState('1123');
  const [height, setHeight] = useState('794');
  const [infinite, setInfinite] = useState(false);
  const [preset, setPreset] = useState<{ gridSize?: number; showGrid?: boolean }>({});
  // 自定义快捷模板表单：默认带入当前宽高，省一次输入。
  const [presetFormOpen, setPresetFormOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetWidth, setPresetWidth] = useState('1123');
  const [presetHeight, setPresetHeight] = useState('794');
  // 模板选中态是单一来源：内置模板 / 自定义模板 / 大画布三者互斥，避免同时高亮。
  const [activeKey, setActiveKey] = useState('template:blank-landscape');
  const presetFormRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const template = TEMPLATES.find((item) => item.id === templateId) ?? TEMPLATES[0];
    setName('');
    setWidth(String(template.width));
    setHeight(String(template.height));
    setInfinite(false);
    setPreset({});
    setPresetFormOpen(false);
    setActiveKey(`template:${templateId}`);
    // 仅在打开面板时重置，切换模板由 chooseTemplate 直接更新尺寸
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 展开自定义模板表单后自动滚到底：小窗口下表单在折叠区外，容易被忽略。
  useEffect(() => {
    if (!open || !presetFormOpen) return;
    const timer = window.setTimeout(() => {
      presetFormRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [open, presetFormOpen]);

  if (!open) return null;

  const chooseTemplate = (id: TemplateId) => {
    const template = TEMPLATES.find((item) => item.id === id) ?? TEMPLATES[0];
    setTemplateId(id);
    setWidth(String(template.width));
    setHeight(String(template.height));
    setInfinite(false);
    setPreset({});
    setActiveKey(`template:${id}`);
  };

  /** 套用自定义模板：只改宽高，保留当前模板的画布类型与网格。 */
  const applyPreset = (presetSize: { id: string; width: number; height: number }) => {
    setWidth(String(presetSize.width));
    setHeight(String(presetSize.height));
    setInfinite(false);
    setPreset({});
    setActiveKey(`custom:${presetSize.id}`);
  };

  const savePreset = () => {
    const w = Math.round(Number.parseFloat(presetWidth));
    const h = Math.round(Number.parseFloat(presetHeight));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return;
    addCanvasPreset(presetName, w, h);
    setPresetFormOpen(false);
  };

  const create = () => {
    const template = TEMPLATES.find((item) => item.id === templateId) ?? TEMPLATES[0];
    // 允许清空后重新输入；提交时回退到模板尺寸
    const parsedWidth = Math.round(Number.parseFloat(width));
    const parsedHeight = Math.round(Number.parseFloat(height));
    startDocumentWith({
      name: name.trim() || undefined,
      templateId,
      width: Number.isFinite(parsedWidth) && parsedWidth >= 1 ? parsedWidth : template.width,
      height: Number.isFinite(parsedHeight) && parsedHeight >= 1 ? parsedHeight : template.height,
      infinite,
      gridSize: preset.gridSize,
      showGrid: preset.showGrid
    });
    onClose();
  };

  return (
    <Modal
      title="新建画布"
      subtitle="配置画布名称、尺寸或直接选择模板"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="create-canvas"
            onClick={create}
          >
            创建画布
          </button>
        </>
      }
    >
      <div className="new-canvas" data-testid="new-canvas-dialog">
        <label className="new-canvas__field">
          <span>画布名称</span>
          <input
            className="input"
            data-testid="canvas-name"
            placeholder="未命名画布"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <div className="new-canvas__row">
          <label className="new-canvas__field">
            <span>宽度</span>
            <div className="input-unit">
              <input
                className="input"
                type="number"
                min={1}
                max={20000}
                data-testid="canvas-width"
                value={infinite ? '4000' : width}
                disabled={infinite}
                onChange={(event) => setWidth(event.target.value)}
              />
              <em>px</em>
            </div>
          </label>
          <label className="new-canvas__field">
            <span>高度</span>
            <div className="input-unit">
              <input
                className="input"
                type="number"
                min={1}
                max={20000}
                data-testid="canvas-height"
                value={infinite ? '4000' : height}
                disabled={infinite}
                onChange={(event) => setHeight(event.target.value)}
              />
              <em>px</em>
            </div>
          </label>
        </div>

        <div className="new-canvas__section">
          <div className="new-canvas__section-head">
            <span>用途模板</span>
            <em>一步预置画布与命名</em>
          </div>
          <div className="usecase-grid">
            {USE_CASES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="usecase-card"
                data-usecase={item.id}
                onClick={() => {
                  chooseTemplate(item.templateId);
                  setName(item.name);
                  setPreset({ gridSize: item.gridSize, showGrid: item.showGrid });
                }}
              >
                <span className="usecase-card__body">
                  <strong>{item.title}</strong>
                  <em>{item.desc}</em>
                </span>
                <Icon name="chevronRight" size={14} className="usecase-card__arrow" />
              </button>
            ))}
          </div>
        </div>

        <div className="new-canvas__section">
          <div className="new-canvas__section-head">
            <span>快捷模板</span>
            <em>选择后自动套用尺寸</em>
          </div>
          <div className="template-grid">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                data-template={template.id}
                className={`template-chip${activeKey === `template:${template.id}` ? ' is-active' : ''}`}
                onClick={() => chooseTemplate(template.id)}
              >
                <span className="template-chip__icon" style={{ color: template.accent }}>
                  <Icon name="file" size={16} />
                </span>
                <span className="template-chip__body">
                  <strong>{template.name}</strong>
                  <em>{template.sizeLabel}</em>
                </span>
              </button>
            ))}
            <button
              type="button"
              data-testid="canvas-infinite"
              className={`template-chip template-chip--infinite${
                activeKey === 'infinite' ? ' is-active' : ''
              }`}
              onClick={() => {
                setInfinite(true);
                setActiveKey('infinite');
              }}
            >
              <span className="template-chip__icon">
                <Icon name="maximize" size={16} />
              </span>
              <span className="template-chip__body">
                <strong>大画布</strong>
                <em>4000 × 4000 固定上限</em>
              </span>
            </button>

            {/* 自定义快捷模板：存的是一组宽高，点一下即可套用到上面的尺寸输入。 */}
            {customTemplates.map((presetSize) => (
              <div className="template-chip-wrap" key={presetSize.id}>
                <button
                  type="button"
                  data-custom-template={presetSize.id}
                  className={`template-chip${
                    activeKey === `custom:${presetSize.id}` ? ' is-active' : ''
                  }`}
                  title={`套用 ${presetSize.name}`}
                  onClick={() => applyPreset(presetSize)}
                >
                  <span className="template-chip__icon" style={{ color: '#0f9d8f' }}>
                    <Icon name="file" size={16} />
                  </span>
                  <span className="template-chip__body">
                    <strong>{presetSize.name}</strong>
                    <em>
                      {presetSize.width} × {presetSize.height}
                    </em>
                  </span>
                </button>
                <button
                  type="button"
                  className="template-chip__remove"
                  data-testid={`custom-template-remove-${presetSize.id}`}
                  title="删除该模板"
                  aria-label={`删除模板 ${presetSize.name}`}
                  onClick={() => {
                    removeCanvasPreset(presetSize.id);
                    // 删掉的正好是当前选中项时，回到内置模板，保证始终有且只有一个高亮。
                    if (activeKey === `custom:${presetSize.id}`) setActiveKey(`template:${templateId}`);
                  }}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            ))}

            <button
              type="button"
              data-testid="custom-template-add"
              className={`template-chip template-chip--add${presetFormOpen ? ' is-open' : ''}`}
              onClick={() => {
                setPresetFormOpen((value) => !value);
                setPresetName('');
                setPresetWidth(width);
                setPresetHeight(height);
              }}
            >
              <span className="template-chip__icon">
                <Icon name="plus" size={16} />
              </span>
              <span className="template-chip__body">
                <strong>自定义模板</strong>
                <em>把当前宽高存成快捷模板</em>
              </span>
            </button>
          </div>

          {presetFormOpen ? (
            <div className="preset-form" data-testid="custom-template-form" ref={presetFormRef}>
              <label className="preset-form__field preset-form__field--name">
                <span>模板名称</span>
                <input
                  className="input"
                  placeholder="留空则用「宽 × 高」命名"
                  data-testid="custom-template-name"
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                />
              </label>
              <label className="preset-form__field">
                <span>宽</span>
                <div className="input-unit input-unit--compact">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={20000}
                    aria-label="模板宽度"
                    data-testid="custom-template-width"
                    value={presetWidth}
                    onChange={(event) => setPresetWidth(event.target.value)}
                  />
                  <em>px</em>
                </div>
              </label>
              <label className="preset-form__field">
                <span>高</span>
                <div className="input-unit input-unit--compact">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={20000}
                    aria-label="模板高度"
                    data-testid="custom-template-height"
                    value={presetHeight}
                    onChange={(event) => setPresetHeight(event.target.value)}
                  />
                  <em>px</em>
                </div>
              </label>
              <div className="preset-form__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  data-testid="custom-template-cancel"
                  onClick={() => setPresetFormOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  data-testid="custom-template-save"
                  onClick={savePreset}
                >
                  保存模板
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
