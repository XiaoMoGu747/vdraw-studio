import type { ReactNode } from 'react';

interface SectionProps {
  title: string;
  badge?: string;
  hint?: string;
  disabled?: boolean;
  children: ReactNode;
}

export function Section({ title, badge, hint, disabled, children }: SectionProps) {
  return (
    <section className={`panel-section${disabled ? ' is-disabled' : ''}`}>
      <header className="panel-section__head">
        <h3>{title}</h3>
        {badge ? <span className="tiny-badge">{badge}</span> : null}
        {hint ? <span className="panel-section__hint">{hint}</span> : null}
      </header>
      <div className="panel-section__body">{children}</div>
    </section>
  );
}
