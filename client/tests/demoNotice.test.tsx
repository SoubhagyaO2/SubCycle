import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, signedInApi } from './mockApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOTICE = /billing is simulated\. No real payments are made and no real money is processed/;

describe('demo disclosures', () => {
  it('shows the simulated-billing notice on the sign-in page', async () => {
    signedInApi().install();
    renderApp('/login');
    expect(await screen.findByRole('note', { name: 'Demo notice' })).toHaveTextContent(NOTICE);
  });

  it('shows the simulated-billing notice and the password-reuse warning on the registration page', async () => {
    signedInApi().install();
    renderApp('/register');
    expect(await screen.findByRole('note', { name: 'Demo notice' })).toHaveTextContent(NOTICE);
    expect(screen.getByText('Do not reuse a real password.')).toBeInTheDocument();
    expect(screen.getByText(/Choose a password you do not use anywhere else/)).toBeInTheDocument();
  });

  it('does not show the password warning on the sign-in page', async () => {
    signedInApi().install();
    renderApp('/login');
    await screen.findByRole('note', { name: 'Demo notice' });
    expect(screen.queryByText('Do not reuse a real password.')).not.toBeInTheDocument();
  });

  it('keeps the notice visible on every signed-in page (it lives in the layout)', async () => {
    signedInApi().install();
    renderApp('/pricing');
    expect(await screen.findByRole('note', { name: 'Demo notice' })).toHaveTextContent(NOTICE);
    expect(screen.getAllByRole('note', { name: 'Demo notice' })).toHaveLength(1);
  });
});
