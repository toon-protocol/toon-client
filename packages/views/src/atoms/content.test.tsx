import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { contentAtoms } from './content.js';
import { type AtomRenderProps } from './types.js';

afterEach(cleanup);

const byId = (id: string) => contentAtoms.find((a) => a.id === id)!.Component;
const base: Omit<AtomRenderProps, 'props'> = {
  events: [],
  actions: {},
  children: null,
  renderEvent: () => null,
};

describe('content primitives', () => {
  it('heading renders its text at the requested level', () => {
    const Heading = byId('heading');
    render(<Heading {...base} props={{ text: 'My status', level: 2 }} />);
    const h = screen.getByRole('heading', { level: 2 });
    expect(h.textContent).toBe('My status');
  });

  it('heading defaults to level 1', () => {
    const Heading = byId('heading');
    render(<Heading {...base} props={{ text: 'Top' }} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Top');
  });

  it('text renders a paragraph; muted dims it', () => {
    const Text = byId('text');
    const { container } = render(<Text {...base} props={{ text: 'hello', muted: true }} />);
    const p = container.querySelector('p')!;
    expect(p.textContent).toBe('hello');
    expect(p.className).toContain('text-muted-foreground');
  });

  it('stat renders label + value and applies tone colour', () => {
    const Stat = byId('stat');
    render(<Stat {...base} props={{ label: 'Buffered', value: 42, tone: 'success' }} />);
    expect(screen.getByText('Buffered')).toBeTruthy();
    const value = screen.getByText('42');
    expect(value.className).toContain('emerald');
  });

  it('key-value renders aligned rows', () => {
    const KeyValue = byId('key-value');
    render(
      <KeyValue
        {...base}
        props={{
          rows: [
            { label: 'npub', value: 'npub1abc' },
            { label: 'chain', value: 'evm' },
          ],
        }}
      />
    );
    expect(screen.getByText('npub')).toBeTruthy();
    expect(screen.getByText('npub1abc')).toBeTruthy();
    expect(screen.getByText('chain')).toBeTruthy();
    expect(screen.getByText('evm')).toBeTruthy();
  });

  it('badge renders its label as a pill', () => {
    const Badge = byId('badge');
    render(<Badge {...base} props={{ label: 'ready', tone: 'success' }} />);
    expect(screen.getByText('ready')).toBeTruthy();
  });

  it('content primitives carry no event kinds', () => {
    for (const atom of contentAtoms) {
      expect(atom.kinds).toBeUndefined();
    }
  });
});
