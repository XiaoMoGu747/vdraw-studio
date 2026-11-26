import { useEffect, useState } from 'react';
import { BOND_PRESETS } from '../../core/chemistry/presets';
import { TOOLS } from '../../core/tools';
import {
  CHEM_ATOM_SIZE_DEFAULT,
  CHEM_ATOM_SIZE_RANGE,
  CHEM_BOND_LENGTH_DEFAULT,
  CHEM_BOND_LENGTH_RANGE,
  CHEM_BOND_SPACING_DEFAULT,
  CHEM_BOND_SPACING_RANGE,
  CHEM_BOND_WIDTH_DEFAULT,
  CHEM_BOND_WIDTH_RANGE,
  useAppStore
} from '../../store/useAppStore';
import type { IconName } from '../../types/ui';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import { useFileActions } from './useFileActions';

type SettingsTab = 'interface' | 'canvas' | 'drawing' | 'chemistry' | 'shortcuts' | 'file';

const TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
  { id: 'interface', label: '界面', icon: 'layers' },
  { id: 'canvas', label: '画布', icon: 'grid' },
  { id: 'drawing', label: '绘画', icon: 'brush' },
  { id: 'chemistry', label: '化学', icon: 'chemistry' },
  { id: 'shortcuts', label: '快捷键', icon: 'history' },
  { id: 'file', label: '文件', icon: 'folder' }
];

function Toggle({
  checked,
  label,
  hint,
  onChange,
  testId
}: {
  checked: boolean;
  label: string;
  hint: string;
  onChange: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className={`settings-toggle${checked ? ' is-on' : ''}`}
      data-testid={testId}
      aria-pressed={checked}
      onClick={onChange}
    >
      <span className="settings-toggle__text">
        <strong>{label}</strong>
        <em>{hint}</em>
      </span>
      <span className="settings-switch">
        <span />
      </span>
    </button>
  );
}

export function SettingsModal() {
  const open = useAppStore((state) => state.settingsOpen);
  const closeSettings = useAppStore((state) => state.closeSettings);
  const showGrid = useAppStore((state) => state.showGrid);
  const showRulers = useAppStore((state) => state.showRulers);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const autoOpenProperties = useAppStore((state) => state.autoOpenProperties);
  const hoverHighlight = useAppStore((state) => state.hoverHighlight);
  const showToolLabels = useAppStore((state) => state.showToolLabels);
  const toggleToolLabels = useAppStore((state) => state.toggleToolLabels);
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const cornerRadius = useAppStore((state) => state.cornerRadius);
  const brushSmoothing = useAppStore((state) => state.brushSmoothing);
  const brushSize = useAppStore((state) => state.brushSize);
  const brushOpacity = useAppStore((state) => state.brushOpacity);
  const eraserSize = useAppStore((state) => state.eraserSize);
  const uiDensity = useAppStore((state) => state.uiDensity);
  const reduceMotion = useAppStore((state) => state.reduceMotion);
  const gridSize = useAppStore((state) => state.gridSize);
  const autoSaveSeconds = useAppStore((state) => state.autoSaveSeconds);
  const exportTransparent = useAppStore((state) => state.exportTransparent);
  const toggleExportTransparent = useAppStore((state) => state.toggleExportTransparent);
  const toolShortcuts = useAppStore((state) => state.toolShortcuts);
  const chem = useAppStore((state) => state.chem);
  const toggleGrid = useAppStore((state) => state.toggleGrid);
  const toggleRulers = useAppStore((state) => state.toggleRulers);
  const toggleSnap = useAppStore((state) => state.toggleSnap);
  const toggleAutoOpenProperties = useAppStore((state) => state.toggleAutoOpenProperties);
  const toggleHoverHighlight = useAppStore((state) => state.toggleHoverHighlight);
  const inlineValence = useAppStore((state) => state.inlineValence);
  const toggleInlineValence = useAppStore((state) => state.toggleInlineValence);
  const implicitHydrogens = useAppStore((state) => state.doc.implicitHydrogens === true);
  const toggleImplicitHydrogens = useAppStore((state) => state.toggleImplicitHydrogens);
  const setCornerRadius = useAppStore((state) => state.setCornerRadius);
  const setBrushSmoothing = useAppStore((state) => state.setBrushSmoothing);
  const setBrushSize = useAppStore((state) => state.setBrushSize);
  const setBrushOpacity = useAppStore((state) => state.setBrushOpacity);
  const setEraserSize = useAppStore((state) => state.setEraserSize);
  const setUiDensity = useAppStore((state) => state.setUiDensity);
  const setReduceMotion = useAppStore((state) => state.setReduceMotion);
  const setGridSize = useAppStore((state) => state.setGridSize);
  const setAutoSaveSeconds = useAppStore((state) => state.setAutoSaveSeconds);
  const setToolShortcut = useAppStore((state) => state.setToolShortcut);
  const resetToolShortcuts = useAppStore((state) => state.resetToolShortcuts);
  const setChem = useAppStore((state) => state.setChemDefaults);
  const chemBondLength = useAppStore((state) => state.chemBondLength);
  const chemBondWidth = useAppStore((state) => state.chemBondWidth);
  const chemBondSpacing = useAppStore((state) => state.chemBondSpacing);
  const chemAtomSize = useAppStore((state) => state.chemAtomSize);
  const setChemBondMetric = useAppStore((state) => state.setChemBondMetric);
  const resetChemBondMetrics = useAppStore((state) => state.resetChemBondMetrics);
  const setChemBondLength = useAppStore((state) => state.setChemBondLength);
  const setChemBondWidth = useAppStore((state) => state.setChemBondWidth);
  const setChemBondSpacing = useAppStore((state) => state.setChemBondSpacing);
  const setChemAtomSize = useAppStore((state) => state.setChemAtomSize);
  const fileActions = useFileActions();
  const [tab, setTab] = useState<SettingsTab>('interface');
  const [saveDir, setSaveDir] = useState('');

  useEffect(() => {
    if (!open) return;
    let active = true;
    void fileActions.getSaveDir().then((info) => {
      if (active && info) setSaveDir(info.directory);
    });
    return () => {
      active = false;
    };
  }, [open]);

  if (!open) return null;

  return (
    <Modal
      title="设置"
      subtitle="界面、绘画、快捷键与化学工具的偏好会保存在本机"
      onClose={closeSettings}
      size="md"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={resetToolShortcuts}>
            恢复默认快捷键
          </button>
          <button type="button" className="btn btn--primary" onClick={closeSettings}>
            完成
          </button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="设置分类">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? 'is-active' : ''}
              data-testid={`settings-tab-${item.id}`}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={15} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="settings-body" data-testid={`settings-panel-${tab}`}>
          {tab === 'interface' ? (
            <section className="settings-section">
              <h3>界面与外观</h3>
              <p className="settings-note">只影响操作界面，不改变文档内容，修改后立即生效。</p>
              <div className="settings-field settings-field--stack">
                <span>
                  <strong>界面密度</strong>
                  <em>紧凑适合小屏，宽松适合触控与演示</em>
                </span>
                <div className="settings-segments" data-testid="settings-density">
                  {([
                    ['compact', '紧凑'],
                    ['standard', '标准'],
                    ['comfortable', '宽松']
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={uiDensity === value ? 'is-active' : ''}
                      data-testid={`settings-density-${value}`}
                      onClick={() => setUiDensity(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-field settings-field--stack">
                <span>
                  <strong>界面主题</strong>
                  <em>深色只影响界面，画布始终保持纸张底色</em>
                </span>
                <div className="settings-segments" data-testid="settings-theme">
                  {([
                    ['light', '浅色'],
                    ['dark', '深色'],
                    ['system', '跟随系统']
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={theme === value ? 'is-active' : ''}
                      data-testid={`settings-theme-${value}`}
                      onClick={() => setTheme(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <Toggle
                checked={reduceMotion}
                label="减少动态效果"
                hint="关闭菜单、面板和提示的过渡动画，降低视觉干扰"
                onChange={() => setReduceMotion(!reduceMotion)}
                testId="settings-reduce-motion"
              />
              <Toggle
                checked={autoOpenProperties}
                label="选中对象时自动打开属性"
                hint="关闭后仍可通过右键“属性”或右侧页签手动打开"
                onChange={toggleAutoOpenProperties}
                testId="settings-auto-properties"
              />
              <Toggle
                checked={showToolLabels}
                label="左侧工具栏显示工具名"
                hint="展开为带标签的图标条（46 → 150px），便于首次识别；小窗口建议关闭"
                onChange={toggleToolLabels}
                testId="settings-tool-labels"
              />
            </section>
          ) : null}

          {tab === 'canvas' ? (
            <section className="settings-section">
              <h3>画布与网格</h3>
              <p className="settings-note">控制画布辅助显示与吸附精度；网格间距会同步当前文档。</p>
              <Toggle
                checked={showGrid}
                label="显示网格"
                hint="在画布上显示网格线"
                onChange={toggleGrid}
                testId="settings-grid"
              />
              <Toggle
                checked={showRulers}
                label="显示标尺"
                hint="画布上方与左侧的坐标标尺"
                onChange={toggleRulers}
                testId="settings-rulers"
              />
              <Toggle
                checked={snapEnabled}
                label="网格吸附"
                hint="移动、绘制和形状端点吸附到网格"
                onChange={toggleSnap}
                testId="settings-snap"
              />
              <div className="settings-field settings-field--stack">
                <span>
                  <strong>网格间距</strong>
                  <em>当前 {gridSize}px；新建文档会沿用此间距</em>
                </span>
                <div className="settings-segments" data-testid="settings-grid-size">
                  {[5, 10, 20, 40].map((size) => (
                    <button
                      key={size}
                      type="button"
                      className={gridSize === size ? 'is-active' : ''}
                      data-testid={`settings-grid-size-${size}`}
                      onClick={() => setGridSize(size)}
                    >
                      {size}px
                    </button>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {tab === 'drawing' ? (
            <section className="settings-section">
              <h3>绘画手感</h3>
              <p className="settings-note">这些参数会立即影响新笔触与新图形。</p>
              <label className="settings-field">
                <span>
                  <strong>画笔平滑</strong>
                  <em>数值越高线条越稳，但跟手更慢、拐角更圆；默认只做轻微平滑</em>
                </span>
                <div className="settings-range">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={brushSmoothing}
                    data-testid="settings-smoothing"
                    onChange={(event) => setBrushSmoothing(Number(event.target.value))}
                  />
                  <b>{brushSmoothing}%</b>
                </div>
              </label>
              <label className="settings-field">
                <span>
                  <strong>矩形圆角</strong>
                  <em>大于 0 时，新绘制的正方形和矩形四角变圆弧</em>
                </span>
                <div className="settings-range">
                  <input
                    type="range"
                    min={0}
                    max={400}
                    step={1}
                    value={Math.min(400, cornerRadius)}
                    data-testid="settings-radius"
                    onChange={(event) => setCornerRadius(Number(event.target.value))}
                  />
                  <input
                    type="number"
                    className="settings-number"
                    min={0}
                    max={400}
                    value={cornerRadius}
                    aria-label="矩形圆角半径数值"
                    data-testid="settings-radius-number"
                    onChange={(event) => setCornerRadius(Number(event.target.value) || 0)}
                  />
                </div>
              </label>
              <label className="settings-field">
                <span>
                  <strong>画笔大小</strong>
                  <em>页面像素；与画笔横栏的粗细滑杆是同一个值</em>
                </span>
                <div className="settings-range">
                  <input
                    type="range"
                    min={0.5}
                    max={60}
                    step={0.5}
                    value={brushSize}
                    data-testid="settings-brush-size"
                    onChange={(event) => setBrushSize(Number(event.target.value))}
                  />
                  <b>{brushSize}px</b>
                </div>
              </label>
              <label className="settings-field">
                <span>
                  <strong>画笔不透明度</strong>
                  <em>新笔触的基础不透明度</em>
                </span>
                <div className="settings-range">
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={1}
                    value={Math.round(brushOpacity * 100)}
                    onChange={(event) => setBrushOpacity(Number(event.target.value) / 100)}
                  />
                  <b>{Math.round(brushOpacity * 100)}%</b>
                </div>
              </label>
              <label className="settings-field">
                <span>
                  <strong>橡皮大小</strong>
                  <em>页面像素，与画笔同一单位；缩放后手感保持同级</em>
                </span>
                <div className="settings-range">
                  <input
                    type="range"
                    min={2}
                    max={80}
                    step={1}
                    value={eraserSize}
                    data-testid="settings-eraser-size"
                    onChange={(event) => setEraserSize(Number(event.target.value))}
                  />
                  <b>{eraserSize}px</b>
                </div>
              </label>
            </section>
          ) : null}

          {tab === 'shortcuts' ? (
            <section className="settings-section">
              <h3>工具快捷键</h3>
              <p className="settings-note">
                输入单个字母或数字覆盖默认值；留空恢复默认。同一按键只保留一个工具。
              </p>
              <div className="settings-shortcuts">
                {TOOLS.filter((tool) => tool.shortcut || tool.id !== 'text').map((tool) => (
                  <label key={tool.id} className="settings-shortcut-row">
                    <span>
                      <Icon name={tool.icon} size={14} />
                      {tool.label}
                    </span>
                    <input
                      type="text"
                      maxLength={1}
                      value={toolShortcuts[tool.id] ?? ''}
                      placeholder={tool.shortcut?.toUpperCase() ?? '—'}
                      data-testid={`settings-shortcut-${tool.id}`}
                      onChange={(event) => setToolShortcut(tool.id, event.target.value)}
                    />
                  </label>
                ))}
              </div>
            </section>
          ) : null}

          {tab === 'chemistry' ? (
            <section className="settings-section">
              <h3>化学工具</h3>
              <p className="settings-note">控制化学工具的默认键型、苯环样式和悬停提示。</p>
              <Toggle
                checked={hoverHighlight}
                label="化学工具悬停高亮"
                hint="悬停原子时圈出原子，悬停化学键时描出键形"
                onChange={toggleHoverHighlight}
                testId="settings-hover"
              />
              <Toggle
                checked={inlineValence}
                label="画布内联显示超价提示"
                hint="超过常见价态的原子会在画布上标出红圈；仅显示明确的超价错误，不刷屏"
                onChange={toggleInlineValence}
                testId="settings-inline-valence"
              />
              <Toggle
                checked={implicitHydrogens}
                label="隐式氢（省略 H 计数）"
                hint="原子标签不再显示 H 数，但数据仍保留；随文档保存并影响导出"
                onChange={toggleImplicitHydrogens}
                testId="settings-implicit-hydrogens"
              />
              <div className="settings-bond-tools">
                <button
                  type="button"
                  className={`settings-bond-link${chem.bondUniform ? ' is-active' : ''}`}
                  data-testid="settings-bond-uniform"
                  aria-pressed={chem.bondUniform}
                  title={
                    chem.bondUniform
                      ? '等比联动：修改任一参数时，另外两项按同一倍率调整'
                      : '独立调整：键长 / 键宽 / 键距分别设置'
                  }
                  onClick={() => setChem({ bondUniform: !chem.bondUniform })}
                >
                  <Icon name={chem.bondUniform ? 'link' : 'unlink'} size={14} />
                  {chem.bondUniform ? '等比联动' : '独立调整'}
                </button>
                <button
                  type="button"
                  className="settings-range__reset"
                  data-testid="settings-bond-defaults"
                  title="恢复化学键默认值"
                  onClick={resetChemBondMetrics}
                >
                  恢复默认 {CHEM_BOND_LENGTH_DEFAULT} / {CHEM_BOND_WIDTH_DEFAULT} /{' '}
                  {CHEM_BOND_SPACING_DEFAULT} / {CHEM_ATOM_SIZE_DEFAULT}
                </button>
              </div>
              <label className="settings-field">
                <span>
                  <strong>化学键键长</strong>
                  <em>
                    新建化学键与环系使用的长度；范围 {CHEM_BOND_LENGTH_RANGE.min}–
                    {CHEM_BOND_LENGTH_RANGE.max}px，默认 {CHEM_BOND_LENGTH_DEFAULT}px
                  </em>
                </span>
                <div className="settings-range">
                  <input
                    type="range"
                    min={CHEM_BOND_LENGTH_RANGE.min}
                    max={CHEM_BOND_LENGTH_RANGE.max}
                    step={1}
                    value={chemBondLength}
                    data-testid="settings-bond-length"
                    onChange={(event) =>
                      setChemBondMetric('length', Number(event.target.value))
                    }
                  />
                  <b>{Math.round(chemBondLength)}px</b>
                  <button
                    type="button"
                    className="settings-range__reset"
                    data-testid="settings-bond-length-reset"
                    disabled={Math.abs(chemBondLength - CHEM_BOND_LENGTH_DEFAULT) < 0.01}
                    title={`恢复默认键长 ${CHEM_BOND_LENGTH_DEFAULT}px`}
                    onClick={() => setChemBondLength(CHEM_BOND_LENGTH_DEFAULT)}
                  >
                    默认 {CHEM_BOND_LENGTH_DEFAULT}px
                  </button>
                </div>
              </label>
              <label className="settings-field">
                <span>
                  <strong>化学键键宽</strong>
                  <em>
                    新建化学键与芳香内圈的线宽；范围 {CHEM_BOND_WIDTH_RANGE.min}–
                    {CHEM_BOND_WIDTH_RANGE.max}px，默认 {CHEM_BOND_WIDTH_DEFAULT.toFixed(1)}px
                  </em>
                </span>
                <div className="settings-range">
                  <input
                    type="range"
                    min={CHEM_BOND_WIDTH_RANGE.min}
                    max={CHEM_BOND_WIDTH_RANGE.max}
                    step={0.1}
                    value={chemBondWidth}
                    data-testid="settings-bond-width"
                    onChange={(event) =>
                      setChemBondMetric('width', Number(event.target.value))
                    }
                  />
                  <b>{chemBondWidth.toFixed(1)}px</b>
                  <button
                    type="button"
                    className="settings-range__reset"
                    data-testid="settings-bond-width-reset"
                    disabled={Math.abs(chemBondWidth - CHEM_BOND_WIDTH_DEFAULT) < 0.01}
                    title={`恢复默认键宽 ${CHEM_BOND_WIDTH_DEFAULT.toFixed(1)}px`}
                    onClick={() => setChemBondWidth(CHEM_BOND_WIDTH_DEFAULT)}
                  >
                    默认 {CHEM_BOND_WIDTH_DEFAULT.toFixed(1)}px
                  </button>
                </div>
              </label>
              <label className="settings-field">
                <span>
                  <strong>化学键键距</strong>
                  <em>
                    双键 / 三键与芳香内线的平行线间距；范围 {CHEM_BOND_SPACING_RANGE.min}–
                    {CHEM_BOND_SPACING_RANGE.max}px，默认 {CHEM_BOND_SPACING_DEFAULT.toFixed(1)}px
                  </em>
                </span>
                <div className="settings-range">
                  <input
                    type="range"
                    min={CHEM_BOND_SPACING_RANGE.min}
                    max={CHEM_BOND_SPACING_RANGE.max}
                    step={0.1}
                    value={chemBondSpacing}
                    data-testid="settings-bond-spacing"
                    onChange={(event) =>
                      setChemBondMetric('spacing', Number(event.target.value))
                    }
                  />
                  <b>{chemBondSpacing.toFixed(1)}px</b>
                  <button
                    type="button"
                    className="settings-range__reset"
                    data-testid="settings-bond-spacing-reset"
                    disabled={Math.abs(chemBondSpacing - CHEM_BOND_SPACING_DEFAULT) < 0.01}
                    title={`恢复默认键距 ${CHEM_BOND_SPACING_DEFAULT.toFixed(1)}px`}
                    onClick={() => setChemBondSpacing(CHEM_BOND_SPACING_DEFAULT)}
                  >
                    默认 {CHEM_BOND_SPACING_DEFAULT.toFixed(1)}px
                  </button>
                </div>
              </label>
              <label className="settings-field">
                <span>
                  <strong>元素大小</strong>
                  <em>
                    新建原子/元素标签的字号；范围 {CHEM_ATOM_SIZE_RANGE.min}–
                    {CHEM_ATOM_SIZE_RANGE.max}px，默认 {CHEM_ATOM_SIZE_DEFAULT}px
                  </em>
                </span>
                <div className="settings-range">
                  <input
                    type="range"
                    min={CHEM_ATOM_SIZE_RANGE.min}
                    max={CHEM_ATOM_SIZE_RANGE.max}
                    step={1}
                    value={chemAtomSize}
                    data-testid="settings-atom-size"
                    onChange={(event) =>
                      setChemBondMetric('atomSize', Number(event.target.value))
                    }
                  />
                  <b>{Math.round(chemAtomSize)}px</b>
                  <button
                    type="button"
                    className="settings-range__reset"
                    data-testid="settings-atom-size-reset"
                    disabled={Math.abs(chemAtomSize - CHEM_ATOM_SIZE_DEFAULT) < 0.01}
                    title={`恢复默认元素大小 ${CHEM_ATOM_SIZE_DEFAULT}px`}
                    onClick={() => setChemAtomSize(CHEM_ATOM_SIZE_DEFAULT)}
                  >
                    默认 {CHEM_ATOM_SIZE_DEFAULT}px
                  </button>
                </div>
              </label>
              <label className="settings-field settings-field--stack">
                <span>
                  <strong>默认键型</strong>
                  <em>新建化学键时使用的键型</em>
                </span>
                <select
                  value={chem.bondType}
                  data-testid="settings-bond-type"
                  onChange={(event) => setChem({ bondType: event.target.value as typeof chem.bondType })}
                >
                  {BOND_PRESETS.map((preset) => (
                    <option key={preset.type} value={preset.type}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="settings-field settings-field--stack">
                <span>
                  <strong>苯环显示</strong>
                  <em>插入苯环时使用的结构式样式</em>
                </span>
                <div className="mode-segment">
                  {(
                    [
                      ['kekule', '凯库勒式'],
                      ['pauling', '鲍林式']
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={chem.benzeneStyle === value ? 'is-active' : ''}
                      onClick={() => setChem({ benzeneStyle: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {tab === 'file' ? (
            <section className="settings-section">
              <h3>文件与恢复</h3>
              <p className="settings-note">自动恢复点只保存在本机，不会上传；导出设置对下一次导出生效。</p>
              <label className="settings-field">
                <span>
                  <strong>自动保存恢复点</strong>
                  <em>异常退出后可恢复最近一次编辑；0 表示关闭定时写入</em>
                </span>
                <select
                  value={autoSaveSeconds}
                  data-testid="settings-autosave"
                  onChange={(event) => setAutoSaveSeconds(Number(event.target.value))}
                >
                  <option value={0}>关闭</option>
                  <option value={15}>每 15 秒</option>
                  <option value={30}>每 30 秒</option>
                  <option value={60}>每 60 秒</option>
                </select>
              </label>
              <Toggle
                checked={exportTransparent}
                label="导出透明背景"
                hint="PNG/SVG 导出时省略白色纸张背景；PDF 始终保留纸张背景"
                onChange={toggleExportTransparent}
                testId="settings-export-transparent"
              />
              <div className="settings-field settings-field--stack">
                <span>
                  <strong>默认保存位置</strong>
                  <em>{saveDir || '正在读取系统下载目录…'}</em>
                </span>
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="settings-open-save-dir"
                  onClick={() => void fileActions.openSaveDir()}
                >
                  打开文件夹
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}