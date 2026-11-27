import { memo, useMemo } from 'react';
import type {
  ArrowObject,
  AtomObject,
  BondObject,
  EllipseObject,
  GroupObject,
  ImageObject,
  LineObject,
  PathObject,
  PolygonObject,
  Rect,
  RectObject,
  SceneObject,
  TextObject,
  VDrawDocument
} from '../../types/document';
import { buildArrowGeometry } from '../../core/arrow';
import { benzeneGeometry } from '../../core/chemistry/benzene';
import { chemistryPreviewIds } from '../../core/chemistry/preview';
import { ATOM_FONT_SIZE, atomLabelLayout, atomParts } from '../../core/chemistry/labels';
import { chemBondShape } from '../../core/chemistry/render';
import { pathData } from '../../core/io/svg';
import {
  eraseMaskDef,
  eraseMaskId,
  hasEraseMask,
  hasStrokeErase,
  strokeEraseMaskDef,
  strokeEraseMaskId
} from '../../core/eraseMask';
import { wrapTextToWidth } from '../../core/textMetrics';
import { brushOutlineData } from '../../core/brush';
import { brushMaterialLayers } from '../../core/brushMaterial';
import { grainBudgetIds } from '../../core/grainBudget';
import { objectInView } from '../../core/viewport';
import { clipPathDef } from '../../core/clipShapes';
import { useAppStore } from '../../store/useAppStore';

function paintValue(paint: SceneObject['style']['fill']): string {
  return paint.type === 'solid' ? paint.color : 'none';
}

export const SceneObjectView = memo(
  function SceneObjectView({
    object,
    doc,
    forceBuckets = false
  }: {
    object: SceneObject;
    doc: VDrawDocument;
    /** 超出文档级逐 dab 预算时，multiply 笔迹退化为 3 个分桶。 */
    forceBuckets?: boolean;
  }) {
  const { style } = object;
  const fill = paintValue(style.fill);
  const stroke = paintValue(style.stroke.paint);
  const dash = style.stroke.dash.length > 0 ? style.stroke.dash.join(' ') : undefined;
  // 线条/描边 mask 只包住 stroke/ink 的渲染，不能套到 fill 上。
  const strokeMask = hasStrokeErase(object)
    ? `url(#${strokeEraseMaskId(object.id)})`
    : undefined;
  const common = {
    fill,
    stroke,
    strokeWidth: style.stroke.width,
    strokeLinecap: style.stroke.cap,
    strokeLinejoin: style.stroke.join,
    strokeDasharray: dash,
    opacity: style.opacity
  } as const;

  // 带宽度信息的画笔笔迹：按"中心线 + 宽度包络"渲染为填充轮廓，
  // 这样压感变宽与起收笔渐隐都能保持矢量可导出（SVG 无逐节点线宽）。
  const brushOutline = useMemo(
    () => (object.type === 'path' ? brushOutlineData(object.nodes) : null),
    [object]
  );
  const materialLayers = useMemo(
    () =>
      object.type === 'path' && object.brushMaterial
        ? brushMaterialLayers(
            object.nodes,
            object.brushMaterial,
            object.style.stroke.width || 2,
            { forceBuckets }
          )
        : null,
    [object, forceBuckets]
  );

  switch (object.type) {
    case 'rect': {
      const rect = object as RectObject;
      const transform = rect.rotation
        ? `rotate(${rect.rotation} ${rect.x + rect.width / 2} ${rect.y + rect.height / 2})`
        : undefined;
      if (strokeMask) {
        return (
          <>
            <rect
              x={rect.x}
              y={rect.y}
              width={Math.max(0, rect.width)}
              height={Math.max(0, rect.height)}
              rx={rect.cornerRadius}
              transform={transform}
              {...common}
              stroke="none"
            />
            <g mask={strokeMask}>
              <rect
                x={rect.x}
                y={rect.y}
                width={Math.max(0, rect.width)}
                height={Math.max(0, rect.height)}
                rx={rect.cornerRadius}
                transform={transform}
                {...common}
                fill="none"
              />
            </g>
          </>
        );
      }
      return (
        <rect
          x={rect.x}
          y={rect.y}
          width={Math.max(0, rect.width)}
          height={Math.max(0, rect.height)}
          rx={rect.cornerRadius}
          transform={transform}
          {...common}
        />
      );
    }
    case 'ellipse': {
      const ellipse = object as EllipseObject;
      const transform = ellipse.rotation
        ? `rotate(${ellipse.rotation} ${ellipse.x + ellipse.width / 2} ${ellipse.y + ellipse.height / 2})`
        : undefined;
      if (strokeMask) {
        return (
          <>
            <ellipse
              cx={ellipse.x + ellipse.width / 2}
              cy={ellipse.y + ellipse.height / 2}
              rx={Math.max(0, ellipse.width / 2)}
              ry={Math.max(0, ellipse.height / 2)}
              transform={transform}
              {...common}
              stroke="none"
            />
            <g mask={strokeMask}>
              <ellipse
                cx={ellipse.x + ellipse.width / 2}
                cy={ellipse.y + ellipse.height / 2}
                rx={Math.max(0, ellipse.width / 2)}
                ry={Math.max(0, ellipse.height / 2)}
                transform={transform}
                {...common}
                fill="none"
              />
            </g>
          </>
        );
      }
      return (
        <ellipse
          cx={ellipse.x + ellipse.width / 2}
          cy={ellipse.y + ellipse.height / 2}
          rx={Math.max(0, ellipse.width / 2)}
          ry={Math.max(0, ellipse.height / 2)}
          transform={transform}
          {...common}
        />
      );
    }
    case 'line': {
      const line = object as LineObject;
      const dx = line.end.x - line.start.x;
      const dy = line.end.y - line.start.y;
      const length = Math.hypot(dx, dy);
      const size = Math.max(7, style.stroke.width * 4);
      const ux = length > 0 ? dx / length : 1;
      const uy = length > 0 ? dy / length : 0;
      const base = { x: line.end.x - ux * size, y: line.end.y - uy * size };
      const wing = size * 0.45;
      const content = (
        <>
          <line
            x1={line.start.x}
            y1={line.start.y}
            x2={line.end.x}
            y2={line.end.y}
            {...common}
          />
          {line.arrowEnd && length > 0.01 ? (
            <polygon
              points={`${line.end.x},${line.end.y} ${base.x - uy * wing},${base.y + ux * wing} ${base.x + uy * wing},${base.y - ux * wing}`}
              fill={stroke === 'none' ? '#1b1b1b' : stroke}
              opacity={style.opacity}
            />
          ) : null}
        </>
      );
      return strokeMask ? <g mask={strokeMask}>{content}</g> : <g>{content}</g>;
    }
    case 'polygon': {
      const polygon = object as PolygonObject;
      const points = polygon.points.map((point) => `${point.x},${point.y}`).join(' ');
      if (strokeMask) {
        return (
          <>
            <polygon points={points} {...common} stroke="none" />
            <g mask={strokeMask}>
              <polygon points={points} {...common} fill="none" />
            </g>
          </>
        );
      }
      return <polygon points={points} {...common} />;
    }
    case 'path': {
      const path = object as PathObject;
      const outline = pathData(path.nodes, path.closed);
      // 填充擦除最优先：mask 里黑色=擦掉，重叠黑块天然合并，
      // 越过外轮廓的黑块也不会涂到填充外面（填充路径本身只有外轮廓）。
      if (hasEraseMask(path)) {
        return (
          <>
            <path
              d={outline}
              fill={fill}
              stroke="none"
              opacity={style.opacity}
              mask={`url(#${eraseMaskId(path.id)})`}
            />
            <g mask={strokeMask}>
              <path
                d={outline}
                fill="none"
                stroke={stroke}
                strokeWidth={style.stroke.width}
                strokeLinecap={style.stroke.cap}
                strokeLinejoin={style.stroke.join}
                strokeDasharray={dash}
                opacity={style.opacity}
              />
            </g>
          </>
        );
      }
      // 画笔笔迹优先：中心线 + 宽度包络渲染为填充轮廓（SVG 无逐节点线宽）。
      if (brushOutline) {
        return (
          <g data-brush-material={materialLayers ? 'true' : undefined} mask={strokeMask}>
            <g
              data-brush-body="true"
              opacity={materialLayers?.bodyOpacity ?? 1}
              style={
                materialLayers?.blendMode === 'multiply'
                  ? { mixBlendMode: 'multiply' }
                  : undefined
              }
            >
              {materialLayers
                ? materialLayers.edges.map((layer, index) => (
                    <path
                      key={`edge-${index}`}
                      d={layer.d}
                      fill={stroke}
                      fillRule="nonzero"
                      stroke="none"
                      opacity={style.opacity * layer.opacity}
                      pointerEvents="none"
                    />
                  ))
                : null}
              <path
                data-brush-main="true"
                d={brushOutline}
                fill={stroke}
                fillRule="nonzero"
                stroke="none"
                opacity={style.opacity}
              />
            </g>
            {materialLayers
              ? materialLayers.grain.map((layer, index) => (
                  <path
                    key={`grain-${index}`}
                    data-brush-grain="true"
                    data-brush-blend={layer.blendMode}
                    d={layer.d}
                    fill={stroke}
                    fillRule="nonzero"
                    stroke="none"
                    opacity={style.opacity * layer.opacity}
                    style={layer.blendMode ? { mixBlendMode: layer.blendMode } : undefined}
                    pointerEvents="none"
                  />
                ))
              : null}
          </g>
        );
      }
      // 等宽笔迹（无节点宽度）也要能看到材质：底层软边 + 主描边 + 颗粒。
      if (materialLayers) {
        return (
          <g data-brush-material="true" mask={strokeMask}>
            <g
              data-brush-body="true"
              opacity={materialLayers.bodyOpacity}
              style={
                materialLayers.blendMode === 'multiply'
                  ? { mixBlendMode: 'multiply' }
                  : undefined
              }
            >
              {materialLayers.edges.map((layer, index) => (
                <path
                  key={`edge-${index}`}
                  d={layer.d}
                  fill={stroke}
                  fillRule="nonzero"
                  stroke="none"
                  opacity={style.opacity * layer.opacity}
                  pointerEvents="none"
                />
              ))}
              {/* 中心线只是骨架：这里只能描边，不能按 fill 填充——
                  开放路径被隐式闭合后会用对象色刷出一块色斑（擦除后最明显）。 */}
              <path
                data-brush-main="true"
                d={outline}
                fill="none"
                stroke={stroke}
                strokeWidth={style.stroke.width}
                strokeLinecap={style.stroke.cap}
                strokeLinejoin={style.stroke.join}
                strokeDasharray={dash}
                opacity={style.opacity}
              />
            </g>
            {materialLayers.grain.map((layer, index) => (
              <path
                key={`grain-${index}`}
                data-brush-grain="true"
                data-brush-blend={layer.blendMode}
                d={layer.d}
                fill={stroke}
                fillRule="nonzero"
                stroke="none"
                opacity={style.opacity * layer.opacity}
                style={layer.blendMode ? { mixBlendMode: layer.blendMode } : undefined}
                pointerEvents="none"
              />
            ))}
          </g>
        );
      }
      if (strokeMask) {
        return (
          <>
            <path d={outline} fill={fill} stroke="none" opacity={style.opacity} />
            <g mask={strokeMask}>
              <path
                d={outline}
                fill="none"
                stroke={stroke}
                strokeWidth={style.stroke.width}
                strokeLinecap={style.stroke.cap}
                strokeLinejoin={style.stroke.join}
                strokeDasharray={dash}
                opacity={style.opacity}
              />
            </g>
          </>
        );
      }
      return <path d={outline} {...common} />;
    }
    case 'text': {
      const text = object as TextObject;
      const anchor = text.align === 'center' ? 'middle' : text.align === 'right' ? 'end' : 'start';
      const x =
        text.align === 'center'
          ? text.x + text.width / 2
          : text.align === 'right'
            ? text.x + text.width
            : text.x;
      const lineHeight = text.lineHeight ?? 1.32;
      // 软换行：原文保留段落，渲染时按框宽计算行。
      const lines = wrapTextToWidth(
        text.text,
        text.maxWidth ?? 0,
        text.fontSize,
        text.letterSpacing ?? 0,
        { fontWeight: text.fontWeight, fontFamily: text.fontFamily, lineHeight }
      ).split('\n');
      const transform = text.rotation
        ? `rotate(${text.rotation} ${text.x + text.width / 2} ${text.y + text.height / 2})`
        : undefined;
      if (text.direction === 'vertical') {
        const characters = [...text.text.replace(/\n/g, '')];
        return (
          <text
            x={x}
            y={text.y}
            fill={fill}
            opacity={style.opacity}
            fontFamily={text.fontFamily}
            fontSize={text.fontSize}
            fontWeight={text.fontWeight}
            fontStyle={text.italic ? 'italic' : undefined}
            textAnchor={anchor}
            dominantBaseline="hanging"
            transform={transform}
          >
            {characters.map((char, index) => (
              <tspan
                key={index}
                x={x}
                y={
                  text.y +
                  index * (text.fontSize * lineHeight + Math.max(0, text.letterSpacing ?? 0))
                }
              >
                {char}
              </tspan>
            ))}
          </text>
        );
      }
      return (
        <text
          x={x}
          y={text.y}
          fill={fill}
          opacity={style.opacity}
          fontFamily={text.fontFamily}
          fontSize={text.fontSize}
          fontWeight={text.fontWeight}
          fontStyle={text.italic ? 'italic' : undefined}
          letterSpacing={text.letterSpacing ?? 0}
          textAnchor={anchor}
          dominantBaseline="hanging"
          transform={transform}
        >
          {lines.map((line, index) => (
            <tspan key={index} x={x} dy={index === 0 ? 0 : text.fontSize * lineHeight}>
              {line || ' '}
            </tspan>
          ))}
        </text>
      );
    }
    case 'image': {
      const image = object as ImageObject;
      const transform = image.rotation
        ? `rotate(${image.rotation} ${image.x + image.width / 2} ${image.y + image.height / 2})`
        : undefined;
      return (
        <image
          href={image.src}
          x={image.x}
          y={image.y}
          width={Math.max(0, image.width)}
          height={Math.max(0, image.height)}
          preserveAspectRatio="none"
          opacity={style.opacity}
          transform={transform}
        />
      );
    }
    case 'bond':
      return <BondView object={object as BondObject} doc={doc} />;
    case 'atom':
      return (
        <AtomView
          object={object as AtomObject}
          doc={doc}
          implicitHydrogens={doc.implicitHydrogens === true}
        />
      );
    case 'arrow':
      return <ArrowView object={object as ArrowObject} />;
    case 'group': {
      const group = object as GroupObject;
      const ringStroke =
        group.style.stroke.paint.type === 'solid' && group.style.stroke.paint.color !== 'none'
          ? group.style.stroke.paint.color
          : '#1b1b1b';
      // 稠环外层没有 ringStyle，用记录下来的圆心为每个苯环画一个内圈。
      if (group.ringCircleStyle === 'pauling' && group.ringCenters && group.ringCenters.length > 0) {
        return (
          <g opacity={group.style.opacity}>
            {group.ringCenters.map((center, index) => (
              <circle
                key={`ring-circle-${index}`}
                cx={center.x}
                cy={center.y}
                r={22 * (group.ringScale ?? 1)}
                fill="none"
                stroke={ringStroke}
                strokeWidth={group.style.stroke.width || 2.2}
              />
            ))}
          </g>
        );
      }
      if (group.ringStyle !== 'pauling') return null;
      // 内圈由环骨架顶点推导，挂上取代基后仍与六元环同心同径
      const geometry = benzeneGeometry(doc, group);
      if (!geometry || !geometry.closed) return null;
      return (
        <circle
          cx={geometry.center.x}
          cy={geometry.center.y}
          r={geometry.circleRadius}
          fill="none"
          stroke={ringStroke}
          strokeWidth={group.style.stroke.width || 2.2}
          opacity={group.style.opacity}
        />
      );
    }
    default:
      return null;
  }
  },
  (prev, next) =>
    prev.object === next.object &&
    prev.forceBuckets === next.forceBuckets &&
    ((prev.object.type !== 'bond' &&
      prev.object.type !== 'group' &&
      prev.object.type !== 'atom') ||
      prev.doc === next.doc)
);

function BondView({ object, doc }: { object: BondObject; doc: VDrawDocument }) {
  const shape = chemBondShape(doc, object);
  const stroke = object.style.stroke.paint.type === 'solid'
    ? object.style.stroke.paint.color
    : '#1b1b1b';
  const width = object.style.stroke.width || 2;
  return (
    <g opacity={object.style.opacity}>
      {shape.geometry.segments.map((segment, index) => (
        <line
          key={`bond-seg-${index}`}
          x1={segment.x1}
          y1={segment.y1}
          x2={segment.x2}
          y2={segment.y2}
          stroke={stroke}
          strokeWidth={width}
          strokeLinecap="round"
        />
      ))}
      {shape.geometry.polygons.map((polygon, index) => (
        <polygon
          key={`bond-poly-${index}`}
          points={polygon.map((point) => `${point.x},${point.y}`).join(' ')}
          fill={stroke}
        />
      ))}
      {shape.geometry.wavyPath ? (
        <path
          d={shape.geometry.wavyPath}
          fill="none"
          stroke={stroke}
          strokeWidth={width}
          strokeLinecap="round"
        />
      ) : null}
    </g>
  );
}

function AtomView({
  object,
  doc,
  implicitHydrogens
}: {
  object: AtomObject;
  doc: VDrawDocument;
  implicitHydrogens: boolean;
}) {
  const hideCharges = useAppStore((state) => state.chemHideCharges);
  const layout = useMemo(() => {
    const bonds = doc.layers
      .flatMap((layer) => layer.objects)
      .filter((item): item is BondObject => item.type === 'bond');
    return atomLabelLayout(object, bonds);
  }, [object, doc]);
  const parts = atomParts(object, implicitHydrogens, layout.flip);
  const fontSize = parts.fontSize;
  const scale = fontSize / ATOM_FONT_SIZE;
  const chargeOnLeft = layout.dx < -1;
  const color =
    object.style.fill.type === 'solid' && object.style.fill.color !== 'none'
      ? object.style.fill.color
      : '#1b1b1b';
  return (
    <g
      transform={`translate(${object.position.x + layout.dx} ${object.position.y + layout.dy})`}
      opacity={object.style.opacity}
    >
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="Cambria, 'Times New Roman', serif"
        fontSize={fontSize}
        fill={color}
      >
        {parts.main}
      </text>
      {parts.isotope ? (
        <text
          x={-parts.width / 2 - 2}
          y={-fontSize * 0.44}
          textAnchor="end"
          fontFamily="Cambria, 'Times New Roman', serif"
          fontSize={fontSize * 0.56}
          fill={color}
        >
          {parts.isotope}
        </text>
      ) : null}
      {parts.charge && !hideCharges ? (
        <text
          x={chargeOnLeft ? -parts.width / 2 - 2 : parts.width / 2 + 2}
          y={-fontSize * 0.44}
          textAnchor={chargeOnLeft ? 'end' : 'start'}
          fontFamily="Cambria, 'Times New Roman', serif"
          fontSize={fontSize * 0.56}
          fill={color}
        >
          {parts.charge}
        </text>
      ) : null}
      {Array.from({ length: parts.radicalCount }).map((_, index) => (
        <circle key={`radical-${index}`} cx={parts.width / 2 + 4 * scale + index * 3.6 * scale} cy={-fontSize * 0.56} r={1.2 * scale} fill={color} />
      ))}
      {Array.from({ length: parts.lonePairs * 2 }).map((_, index) => (
        <circle
          key={`lone-${index}`}
          cx={parts.width / 2 + 7 * scale + (index % 2) * 4.2 * scale}
          cy={-2 * scale + Math.floor(index / 2) * 4.5 * scale}
          r={1.1 * scale}
          fill={color}
        />
      ))}
    </g>
  );
}

function ArrowView({ object }: { object: ArrowObject }) {
  const geometry = buildArrowGeometry(object.arrowKind, object.start, object.end);
  const stroke = object.style.stroke.paint.type === 'solid'
    ? object.style.stroke.paint.color
    : '#1b1b1b';
  const width = object.style.stroke.width || 1.8;
  return (
    <g opacity={object.style.opacity}>
      {geometry.lines.map((line, index) => (
        <line
          key={`arrow-line-${index}`}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke={stroke}
          strokeWidth={width}
          strokeLinecap="round"
        />
      ))}
      {geometry.polygons.map((polygon, index) => (
        <polygon
          key={`arrow-head-${index}`}
          points={polygon.map((point) => `${point.x},${point.y}`).join(' ')}
          fill={stroke}
        />
      ))}
      {geometry.curve ? (
        <path d={geometry.curve} fill="none" stroke={stroke} strokeWidth={width} strokeLinecap="round" />
      ) : null}
      {object.label ? (
        <text
          x={(object.start.x + object.end.x) / 2}
          y={(object.start.y + object.end.y) / 2 - 10}
          textAnchor="middle"
          fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
          fontSize={12}
          fill={stroke}
        >
          {object.label.split('\n').map((line, index) => (
            <tspan key={index} x={(object.start.x + object.end.x) / 2} dy={index === 0 ? 0 : 13}>
              {line || ' '}
            </tspan>
          ))}
        </text>
      ) : null}
    </g>
  );
}

export const SceneRenderer = memo(function SceneRenderer({
  doc,
  viewRect
}: {
  doc: VDrawDocument;
  /** 视口裁剪矩形（页面坐标）；不传则渲染全部对象（导出/测试用）。 */
  viewRect?: Rect;
}) {
  // 拖拽预览独立于文档：
  // - move / rotate 只让选中对象的外层 <g> 改 transform；
  // - resize 用同一份预览文档渲染，未选中对象引用不变，memo 自动跳过。
  const dragPreview = useAppStore((state) => state.dragPreview);
  const previewIds = useMemo(
    () => new Set(dragPreview?.ids ?? []),
    [dragPreview]
  );
  const renderDoc = dragPreview?.doc ?? doc;
  // 文档级预算：前 N 条 multiply 笔迹逐 dab，超出的退化为分桶，避免大量笔迹撑爆 DOM。
  const perDabIds = useMemo(() => grainBudgetIds(renderDoc), [renderDoc]);
  // resize 预览只让受影响的键/环拿预览文档，其余化学对象保持原引用，memo 不失效。
  const chemistryIds = useMemo(
    () => (dragPreview?.doc ? chemistryPreviewIds(renderDoc, previewIds) : null),
    [dragPreview?.doc, previewIds, renderDoc]
  );
  const clipDefs = useMemo(
    () =>
      renderDoc.layers
        .flatMap((layer) => layer.objects)
        .filter((object) => object.clipIds?.length)
        .map((object) => clipPathDef(renderDoc, object))
        .filter(Boolean)
        .join(''),
    [renderDoc]
  );
  const eraseDefs = useMemo(
    () =>
      renderDoc.layers
        .flatMap((layer) => layer.objects)
        .filter((object): object is PathObject => object.type === 'path' && hasEraseMask(object))
        .map((object) => eraseMaskDef(object))
        .filter(Boolean)
        .join(''),
    [renderDoc]
  );
  const strokeEraseDefs = useMemo(
    () =>
      renderDoc.layers
        .flatMap((layer) => layer.objects)
        .filter((object) => hasStrokeErase(object))
        .map((object) => strokeEraseMaskDef(object))
        .filter(Boolean)
        .join(''),
    [renderDoc]
  );

  return (
    <g className="scene-layer">
      {clipDefs ? <defs dangerouslySetInnerHTML={{ __html: clipDefs }} /> : null}
      {eraseDefs ? <defs dangerouslySetInnerHTML={{ __html: eraseDefs }} /> : null}
      {strokeEraseDefs ? (
        <defs dangerouslySetInnerHTML={{ __html: strokeEraseDefs }} />
      ) : null}
      {renderDoc.layers.map((layer) => {
        if (!layer.visible) return null;
        return (
          <g
            key={layer.id}
            data-layer-id={layer.id}
            style={
              layer.blendMode && layer.blendMode !== 'normal'
                ? { mixBlendMode: layer.blendMode }
                : undefined
            }
          >
            {layer.objects.map((object) => {
              if (!object.visible || (viewRect && !objectInView(object, viewRect))) return null;
              const forceBuckets =
                object.type === 'path' &&
                object.brushMaterial?.blendMode === 'multiply' &&
                !perDabIds.has(object.id);
              return (
                <g
                  key={object.id}
                  data-object-id={object.id}
                  data-drag-preview={dragPreview && previewIds.has(object.id) ? 'true' : undefined}
                  transform={
                    dragPreview && previewIds.has(object.id) ? dragPreview.transform : undefined
                  }
                  clipPath={object.clipIds?.length ? `url(#clip-${object.id})` : undefined}
                >
                  {/* 只有受缩放影响的键/环需要按预览文档重算；其余对象保持原 doc。 */}
                  <SceneObjectView
                    object={object}
                    doc={chemistryIds?.has(object.id) ? renderDoc : doc}
                    forceBuckets={forceBuckets}
                  />
                </g>
              );
            })}
          </g>
        );
      })}
    </g>
  );
});
