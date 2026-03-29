import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect } from 'vitest';
import { AppLayout } from '@/app/app-layout';

describe('[P0] AppLayout', () => {
  it('renders TopNav with TOON Forge branding', () => {
    render(
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>,
    );
    expect(screen.getByText('TOON Forge')).toBeInTheDocument();
  });
});
